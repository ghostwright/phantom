// Email login handler. Validates email against OWNER_EMAIL env var,
// generates a magic link, and sends it via Resend. Rate-limited to
// 1 request per 60 seconds per IP. Always returns 200 with neutral
// response to prevent email enumeration.

import { createSession } from "../ui/session.ts";
import { escapeHtml } from "./util/escape.ts";

// Sanitize the agent name into an email from-address local-part.
// PhantomConfigSchema already restricts `name` to a safe charset, but we
// defend in depth: lowercase, collapse spaces/underscores/dots to hyphens,
// strip anything that is not alphanumeric or hyphen, collapse runs of
// hyphens, and trim leading/trailing hyphens. Falls back to "agent" if
// the result is empty or shorter than 3 chars to keep Resend happy.
export function sanitizeLocalPart(agentName: string): string {
	const lowered = agentName.toLowerCase();
	const collapsed = lowered.replace(/[\s_.]+/g, "-");
	const stripped = collapsed.replace(/[^a-z0-9-]/g, "");
	const normalized = stripped.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return normalized.length >= 3 ? normalized : "agent";
}

// Strip CR/LF from header values to defend against header injection.
// PhantomConfigSchema already rejects these at load, but be defensive.
function sanitizeHeader(value: string): string {
	return value.replace(/[\r\n]/g, "");
}

type RateLimitEntry = { lastSent: number };
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MS = 60_000; // 1 per 60 seconds per IP

export function clearRateLimits(): void {
	rateLimitMap.clear();
}

export async function handleEmailLogin(
	req: Request,
	publicUrl: string,
	agentName: string,
	domain: string,
): Promise<Response> {
	const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

	// Rate limit check
	const entry = rateLimitMap.get(ip);
	if (entry && Date.now() - entry.lastSent < RATE_LIMIT_MS) {
		return Response.json({ ok: true });
	}

	let body: { email?: string };
	try {
		body = (await req.json()) as { email?: string };
	} catch {
		return Response.json({ ok: true });
	}

	if (!body.email || typeof body.email !== "string") {
		return Response.json({ ok: true });
	}

	const ownerEmail = process.env.OWNER_EMAIL;
	if (!ownerEmail) {
		return Response.json({ ok: true });
	}

	// Normalize and compare
	const inputEmail = body.email.trim().toLowerCase();
	const targetEmail = ownerEmail.trim().toLowerCase();

	if (inputEmail !== targetEmail) {
		// Record rate limit even for mismatches to prevent probing
		rateLimitMap.set(ip, { lastSent: Date.now() });
		return Response.json({ ok: true });
	}

	// Match - generate magic link and send
	rateLimitMap.set(ip, { lastSent: Date.now() });

	const { magicToken } = createSession();
	const magicUrl = `${publicUrl}/ui/login?magic=${encodeURIComponent(magicToken)}&redirect=%2Fchat`;

	await sendLoginEmail(ownerEmail, magicUrl, agentName, domain);

	// Evict expired entries to prevent unbounded map growth
	if (rateLimitMap.size > 1000) {
		const cutoff = Date.now() - RATE_LIMIT_MS;
		for (const [entryIp, entryVal] of rateLimitMap) {
			if (entryVal.lastSent < cutoff) rateLimitMap.delete(entryIp);
		}
	}

	return Response.json({ ok: true });
}

export async function sendLoginEmail(
	email: string,
	magicLink: string,
	agentName: string,
	domain: string,
): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY;
	if (!apiKey) {
		console.log(`[email-login] No RESEND_API_KEY set. Magic link for ${email}:`);
		console.log(`  ${magicLink}`);
		return;
	}

	try {
		const { Resend } = await import("resend");
		const resend = new Resend(apiKey);
		const safeDisplayName = sanitizeHeader(agentName);
		const safeLocalPart = sanitizeLocalPart(agentName);
		const safeHtmlName = escapeHtml(agentName);
		const from = `${safeDisplayName} <${safeLocalPart}@${domain}>`;

		const htmlBody = `
<p>Sign in to ${safeHtmlName}. Click the link below within 10 minutes:</p>
<p><a href="${magicLink}" style="display:inline-block;padding:12px 24px;background:#4850c4;color:#fff;text-decoration:none;border-radius:8px;">Sign in</a></p>
<p style="color:#888;font-size:13px;">This link can be used once. Your session lasts 7 days.</p>
<p style="color:#888;font-size:13px;">If you did not request this, you can ignore this email.</p>
`.trim();

		const { error } = await resend.emails.send({
			from,
			to: [email],
			subject: `${safeDisplayName} - Login link`,
			html: htmlBody,
			text: `Sign in to ${safeDisplayName}: ${magicLink}\n\nThis link expires in 10 minutes and can be used once.`,
		});

		if (error) {
			throw new Error(`Resend API error: ${error.message}`);
		}

		console.log(`[email-login] Sent login email to ${email}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[email-login] Failed to send: ${msg}`);
		throw err;
	}
}
