// Boot-time first-run detection and email trigger.
// Called from src/index.ts after channels are registered. If Slack is not
// configured, this sends the first login email or prints a bootstrap token.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createSession } from "../ui/session.ts";
import { sendLoginEmail } from "./email-login.ts";

type FirstRunState = {
	email_sent_at: string | null;
	stdout_printed_at: string | null;
	bootstrap_magic_hash: string | null;
};

function getFirstRunState(db: Database): FirstRunState | null {
	const row = db
		.query("SELECT email_sent_at, stdout_printed_at, bootstrap_magic_hash FROM first_run_state WHERE id = 1")
		.get();
	return row as FirstRunState | null;
}

function ensureFirstRunRow(db: Database): void {
	db.run("INSERT OR IGNORE INTO first_run_state (id) VALUES (1)");
}

export async function handleFirstRun(
	db: Database,
	config: { name: string; public_url?: string; domain?: string },
): Promise<void> {
	const ownerEmail = process.env.OWNER_EMAIL;
	if (!ownerEmail) {
		console.warn("[first-run] No OWNER_EMAIL set and no Slack configured.");
		console.warn("[first-run] The web chat UI requires a login token. Set OWNER_EMAIL in .env for email-based login.");
		console.warn("[first-run] MCP and CLI channels are not affected.");
		return;
	}

	ensureFirstRunRow(db);
	const state = getFirstRunState(db);

	if (state?.email_sent_at || state?.stdout_printed_at) {
		return; // Already handled in a previous boot
	}

	const publicUrl = config.public_url;
	const hasResend = !!process.env.RESEND_API_KEY;

	if (hasResend && publicUrl) {
		// Option A: send email via Resend
		const { magicToken } = createSession();
		const magicUrl = `${publicUrl}/ui/login?magic=${encodeURIComponent(magicToken)}&redirect=%2Fchat`;

		// Store hash for restart resilience
		const hash = createHash("sha256").update(magicToken).digest("hex");
		db.run("UPDATE first_run_state SET bootstrap_magic_hash = ? WHERE id = 1", [hash]);

		try {
			await sendLoginEmail(ownerEmail, magicUrl, config.name, config.domain ?? "ghostwright.dev");
			db.run("UPDATE first_run_state SET email_sent_at = datetime('now') WHERE id = 1");
			console.log(`[first-run] Login email sent to ${ownerEmail}`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[first-run] Email delivery failed: ${msg}`);
			// Fall through to stdout
			printBootstrapBanner(db, config);
		}
	} else {
		// Option B: print to stdout
		printBootstrapBanner(db, config);
	}
}

function printBootstrapBanner(db: Database, config: { name: string; public_url?: string }): void {
	const { magicToken } = createSession();

	// Store hash for restart resilience (30-minute TTL enforced at consume time)
	const hash = createHash("sha256").update(magicToken).digest("hex");
	db.run("UPDATE first_run_state SET bootstrap_magic_hash = ?, stdout_printed_at = datetime('now') WHERE id = 1", [
		hash,
	]);

	const separator = "=".repeat(60);
	console.log("");
	console.log(separator);
	console.log(`  ${config.name.toUpperCase()} FIRST-RUN BOOTSTRAP TOKEN`);
	console.log("  Paste this into the login page within 30 minutes:");
	console.log("");
	console.log(`    ${magicToken}`);
	if (config.public_url) {
		console.log("");
		console.log("  Or click this link:");
		console.log(`    ${config.public_url}/ui/login?magic=${encodeURIComponent(magicToken)}&redirect=%2Fchat`);
	}
	console.log(separator);
	console.log("");
}

// Check if a token matches the bootstrap magic hash (for restart resilience)
export function checkBootstrapMagicHash(db: Database, token: string): boolean {
	ensureFirstRunRow(db);
	const state = getFirstRunState(db);
	if (!state?.bootstrap_magic_hash) return false;

	const hash = createHash("sha256").update(token).digest("hex");
	if (hash !== state.bootstrap_magic_hash) return false;

	// Check if the stdout was printed within the last 30 minutes
	const printedAt = state.stdout_printed_at ?? state.email_sent_at;
	if (!printedAt) return false;

	const printedTime = new Date(printedAt).getTime();
	const thirtyMinutes = 30 * 60 * 1000;
	if (Date.now() - printedTime > thirtyMinutes) return false;

	// Consume it (one-time use)
	db.run("UPDATE first_run_state SET bootstrap_magic_hash = NULL WHERE id = 1");
	return true;
}
