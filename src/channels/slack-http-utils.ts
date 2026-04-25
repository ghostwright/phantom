// Phase 5b: Express-side request helpers used by the HTTP receiver guard
// middleware. Body reading, header normalization, content-type sniffing,
// rehydration after stream consumption, the url_verification body shape
// detector, and the token redactor all live here so the receiver itself
// can focus on lifecycle and dispatch.

import type { Request } from "express";

export type RequestWithRawBody = Request & { rawBody?: Buffer };

export function headerString(req: Request, name: string): string | null {
	const value = req.headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0] ?? null;
	return typeof value === "string" ? value : null;
}

export function getContentType(req: Request): string {
	return headerString(req, "content-type") ?? "application/json";
}

export async function readRequestBody(req: RequestWithRawBody): Promise<Buffer> {
	if (req.rawBody) {
		return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			if (chunk == null) return;
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", (err: Error) => reject(err));
	});
}

/**
 * After we have consumed the request stream to verify HMAC, ExpressReceiver's
 * downstream body parser still expects to read a body. We pre-parse JSON or
 * urlencoded bodies onto `req.body` so subsequent middleware finds the
 * already-parsed payload via the standard Express convention.
 */
export function rehydrateBody(req: Request, raw: Buffer): void {
	const ctype = getContentType(req).toLowerCase();
	if (ctype.includes("application/json")) {
		try {
			req.body = JSON.parse(raw.toString("utf-8"));
		} catch {
			// Leave body unset; downstream parser will surface the error.
		}
	} else if (ctype.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(raw.toString("utf-8"));
		const obj: Record<string, string> = {};
		for (const [k, v] of params) obj[k] = v;
		req.body = obj;
	}
}

/**
 * Detects Slack's `url_verification` challenge ping. This is the one
 * legitimate forwarded body shape that lacks a `team_id` field. Returning
 * `true` is the only path the middleware uses to allow a no-team_id
 * request through; everything else is rejected as defense in depth.
 */
export function isUrlVerificationBody(raw: Buffer, contentType: string): boolean {
	if (!contentType.toLowerCase().includes("application/json")) return false;
	try {
		const parsed = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
		return parsed?.type === "url_verification";
	} catch {
		return false;
	}
}

/**
 * Strip Slack token prefixes (xoxb-, xoxp-, xapp-, xoxc-, xoxe-) from any
 * string. The auth.test() failure path runs the upstream error message
 * through this redactor so a hostile or future-Bolt-debug error message
 * carrying a token cannot leak it via our stderr.
 */
export function redactTokens(s: string): string {
	return s.replace(/xox[bpaec]-[a-zA-Z0-9-]+/g, "[REDACTED-TOKEN]").replace(/xapp-[a-zA-Z0-9-]+/g, "[REDACTED-TOKEN]");
}
