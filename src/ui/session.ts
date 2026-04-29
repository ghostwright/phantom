import { randomBytes } from "node:crypto";

type Session = {
	token: string;
	createdAt: number;
	expiresAt: number;
};

type MagicLink = {
	token: string;
	sessionToken: string;
	expiresAt: number;
	used: boolean;
};

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAGIC_LINK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PREVIEW_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const sessions = new Map<string, Session>();
const magicLinks = new Map<string, MagicLink>();

export function createSession(): { sessionToken: string; magicToken: string } {
	const sessionToken = randomBytes(32).toString("base64url");
	const magicToken = randomBytes(24).toString("base64url");
	const now = Date.now();

	sessions.set(sessionToken, {
		token: sessionToken,
		createdAt: now,
		expiresAt: now + SESSION_TTL_MS,
	});

	magicLinks.set(magicToken, {
		token: magicToken,
		sessionToken,
		expiresAt: now + MAGIC_LINK_TTL_MS,
		used: false,
	});

	return { sessionToken, magicToken };
}

// Mint a short-lived session for phantom_preview_page. The returned token is
// injected as a cookie into the Playwright BrowserContext so the preview tool
// can authenticate against /ui/<path> without minting a magic link. The short
// TTL bounds blast radius: if the cookie ever leaks out of the container, it
// self-destructs in ten minutes and cannot be refreshed.
export function createPreviewSession(): { sessionToken: string } {
	const sessionToken = randomBytes(32).toString("base64url");
	const now = Date.now();
	sessions.set(sessionToken, {
		token: sessionToken,
		createdAt: now,
		expiresAt: now + PREVIEW_SESSION_TTL_MS,
	});
	return { sessionToken };
}

export function isValidSession(token: string): boolean {
	const session = sessions.get(token);
	if (!session) return false;
	if (Date.now() > session.expiresAt) {
		sessions.delete(token);
		return false;
	}
	return true;
}

export function consumeMagicLink(magicToken: string): string | null {
	const link = magicLinks.get(magicToken);
	if (!link || link.used || Date.now() > link.expiresAt) {
		if (link) magicLinks.delete(magicToken);
		return null;
	}
	link.used = true;
	magicLinks.delete(magicToken);
	return link.sessionToken;
}

export function revokeAllSessions(): void {
	sessions.clear();
	magicLinks.clear();
}

export function getSessionCount(): number {
	return sessions.size;
}

export function getMagicLinkCount(): number {
	return magicLinks.size;
}
