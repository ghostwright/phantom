import { z } from "zod";
import { type McpSdkServerConfigWithInstance, createSdkMcpServer, tool } from "../agent/agent-sdk.ts";

type EmailToolDeps = {
	agentName: string;
	domain: string;
	dailyLimit: number;
};

// In-memory daily counter. Resets on restart and when the date changes.
// Resend's own rate limits (5 req/s, 100/day free tier) are the real enforcement.
// This is a soft safety net to catch agent send loops before they hit Resend.
let sentToday = 0;
let lastResetDate = new Date().toDateString();

function checkDailyLimit(limit: number): { allowed: boolean; remaining: number } {
	const today = new Date().toDateString();
	if (today !== lastResetDate) {
		sentToday = 0;
		lastResetDate = today;
	}
	return { allowed: sentToday < limit, remaining: Math.max(0, limit - sentToday) };
}

function ok(data: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

export function createEmailToolServer(deps: EmailToolDeps): McpSdkServerConfigWithInstance {
	const fromAddress = `${deps.agentName}@${deps.domain}`;

	const sendEmailTool = tool(
		"phantom_send_email",
		`Send an email from ${fromAddress}. Use this to send reports, summaries, notifications, or any email to your owner or other recipients. The from address is fixed - you always send as yourself. Rate limit: ${deps.dailyLimit} emails per day.`,
		{
			to: z.union([z.string().email(), z.array(z.string().email())]).describe("Recipient email address(es). Max 50."),
			subject: z.string().min(1).max(998).describe("Email subject line"),
			text: z.string().min(1).describe("Plain text body of the email"),
			html: z.string().optional().describe("Optional HTML body. If omitted, plain text is used."),
			cc: z
				.union([z.string().email(), z.array(z.string().email())])
				.optional()
				.describe("CC recipients"),
			bcc: z
				.union([z.string().email(), z.array(z.string().email())])
				.optional()
				.describe("BCC recipients"),
			replyTo: z
				.union([z.string().email(), z.array(z.string().email())])
				.optional()
				.describe("Reply-to address(es)"),
		},
		async (input) => {
			try {
				const rateCheck = checkDailyLimit(deps.dailyLimit);
				if (!rateCheck.allowed) {
					return err(`Daily email limit reached (${deps.dailyLimit}). Resets at midnight.`);
				}

				const apiKey = process.env.RESEND_API_KEY;
				if (!apiKey) {
					return err("Email not configured. RESEND_API_KEY is not set.");
				}

				// Lazy-load so the resend package is never imported when email is unconfigured
				const { Resend } = await import("resend");
				const resend = new Resend(apiKey);

				const { data, error } = await resend.emails.send({
					from: `${deps.agentName} <${fromAddress}>`,
					to: Array.isArray(input.to) ? input.to : [input.to],
					subject: input.subject,
					text: input.text,
					html: input.html,
					cc: input.cc ? (Array.isArray(input.cc) ? input.cc : [input.cc]) : undefined,
					bcc: input.bcc ? (Array.isArray(input.bcc) ? input.bcc : [input.bcc]) : undefined,
					replyTo: input.replyTo ? (Array.isArray(input.replyTo) ? input.replyTo : [input.replyTo]) : undefined,
				});

				if (error) {
					return err(error.message);
				}

				sentToday++;

				return ok({
					sent: true,
					id: data?.id,
					from: fromAddress,
					to: input.to,
					subject: input.subject,
					remaining: deps.dailyLimit - sentToday,
				});
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-email",
		tools: [sendEmailTool],
	});
}
