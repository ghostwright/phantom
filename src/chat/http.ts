import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../agent/runtime.ts";
import { avatarUrlIfPresent, readAvatarMetaForManifest } from "../ui/api/identity.ts";
import { isAuthenticated } from "../ui/serve.ts";
import type { ChatAttachmentStore } from "./attachment-store.ts";
import type { ChatEventLog } from "./event-log.ts";
import {
	handleAbort,
	handleAttachmentPreview,
	handleDeleteSession,
	handleForkSession,
	handleGetSession,
	handleResume,
	handleStream,
	handleUpdateSession,
} from "./http-handlers.ts";
import type { ChatMessageStore } from "./message-store.ts";
import type { SessionFocusMap } from "./notifications/focus.ts";
import { testPayload } from "./notifications/payload.ts";
import { broadcastNotification } from "./notifications/sender.ts";
import { isValidPushEndpoint, subscribe, unsubscribe } from "./notifications/subscriptions.ts";
import type { NotificationTriggerService } from "./notifications/triggers.ts";
import type { VapidKeyPair } from "./notifications/vapid.ts";
import { handleChatStaticRequest } from "./serve.ts";
import type { ChatSessionStore } from "./session-store.ts";
import type { StreamBus } from "./stream-bus.ts";
import { handleUploadAttachments } from "./upload.ts";

export type ChatHandlerDeps = {
	runtime: AgentRuntime;
	sessionStore: ChatSessionStore;
	messageStore: ChatMessageStore;
	eventLog: ChatEventLog;
	attachmentStore: ChatAttachmentStore;
	streamBus: StreamBus;
	getBootstrapData?: () => Record<string, unknown>;
	db?: Database;
	vapidKeys?: VapidKeyPair;
	focusMap?: SessionFocusMap;
	ownerEmail?: string;
	agentName?: string;
	notificationTriggers?: NotificationTriggerService;
};

export function createChatHandler(deps: ChatHandlerDeps): (req: Request) => Promise<Response | null> {
	return async (req: Request): Promise<Response | null> => {
		const url = new URL(req.url);
		const path = url.pathname;

		if (path.startsWith("/chat") && isApiPath(path)) {
			if (!isAuthenticated(req)) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}
			const response = await routeApi(req, url, path, deps);
			if (response) return response;
		}

		// Serve the manifest dynamically so the PWA name reflects the
		// configured agent identity instead of the build-time "Phantom"
		// literal. iOS reads `name` from the manifest when the
		// `apple-mobile-web-app-title` meta is absent, so this is the
		// only place that mutation reaches the home-screen label.
		if (path === "/chat/manifest.webmanifest") {
			return serveManifest(deps.agentName);
		}

		// Serve favicon without auth (browsers fetch it without credentials)
		if (path === "/chat/favicon.svg") {
			return handleChatStaticRequest(req);
		}

		if (!isAuthenticated(req)) {
			const accept = req.headers.get("Accept") ?? "";
			if (accept.includes("text/html")) {
				return Response.redirect("/ui/login", 302);
			}
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		return handleChatStaticRequest(req);
	};
}

function isApiPath(path: string): boolean {
	return (
		path === "/chat/bootstrap" ||
		path === "/chat/sessions" ||
		path === "/chat/stream" ||
		path === "/chat/focus" ||
		path.startsWith("/chat/sessions/") ||
		path.startsWith("/chat/events/") ||
		path.startsWith("/chat/push/") ||
		path.startsWith("/chat/attachments/")
	);
}

async function routeApi(req: Request, url: URL, path: string, deps: ChatHandlerDeps): Promise<Response | null> {
	if (path === "/chat/bootstrap" && req.method === "GET") {
		const base = deps.getBootstrapData?.() ?? {};
		return Response.json({ ...base, avatar_url: avatarUrlIfPresent() });
	}

	if (path === "/chat/sessions" && req.method === "POST") {
		return handleCreateSession(req, deps);
	}

	if (path === "/chat/sessions" && req.method === "GET") {
		return handleListSessions(url, deps);
	}

	if (path === "/chat/stream" && req.method === "POST") {
		return handleStream(req, deps);
	}

	if (path === "/chat/focus" && req.method === "POST") {
		return handleFocusUpdate(req, deps);
	}

	if (path === "/chat/push/vapid-key" && req.method === "GET") {
		if (!deps.vapidKeys) return Response.json({ error: "Push not configured" }, { status: 503 });
		return Response.json({ publicKey: deps.vapidKeys.publicKey });
	}

	if (path === "/chat/push/subscribe" && req.method === "POST") {
		return handlePushSubscribe(req, deps);
	}

	if (path === "/chat/push/subscribe" && req.method === "DELETE") {
		return handlePushUnsubscribe(req, deps);
	}

	if (path === "/chat/push/test" && req.method === "POST") {
		return handlePushTest(deps);
	}

	const sessionMatch = path.match(/^\/chat\/sessions\/([^/]+)(\/.*)?$/);
	if (sessionMatch) {
		const sessionId = sessionMatch[1];
		const suffix = sessionMatch[2] ?? "";
		return routeSessionApi(req, sessionId, suffix, deps);
	}

	const attachmentMatch = path.match(/^\/chat\/attachments\/([^/]+)\/preview$/);
	if (attachmentMatch && req.method === "GET") {
		const attachmentId = attachmentMatch[1] ?? "";
		return handleAttachmentPreview(attachmentId, deps);
	}

	const eventsMatch = path.match(/^\/chat\/events\/(\d+)\/full-output$/);
	if (eventsMatch && req.method === "GET") {
		return Response.json({ error: "Not implemented" }, { status: 501 });
	}

	return null;
}

async function routeSessionApi(
	req: Request,
	sessionId: string,
	suffix: string,
	deps: ChatHandlerDeps,
): Promise<Response | null> {
	if (suffix === "" && req.method === "GET") return handleGetSession(sessionId, deps);
	if (suffix === "" && req.method === "PATCH") return handleUpdateSession(req, sessionId, deps);
	if (suffix === "" && req.method === "DELETE") return handleDeleteSession(sessionId, deps);

	if (suffix === "/fork" && req.method === "POST") return handleForkSession(req, sessionId, deps);

	if (suffix === "/title/reset" && req.method === "POST") {
		deps.sessionStore.resetTitle(sessionId);
		return Response.json({ ok: true });
	}

	if (suffix === "/resume" && req.method === "POST") return handleResume(req, sessionId, deps);
	if (suffix === "/abort" && req.method === "POST") return handleAbort(sessionId);

	if (suffix === "/attachments" && req.method === "POST") {
		return handleUploadAttachments(req, sessionId, {
			sessionStore: deps.sessionStore,
			attachmentStore: deps.attachmentStore,
		});
	}

	return null;
}

async function handleCreateSession(req: Request, deps: ChatHandlerDeps): Promise<Response> {
	let body: { title?: string } = {};
	try {
		body = (await req.json()) as { title?: string };
	} catch {
		/* empty body */
	}
	const session = deps.sessionStore.create(body.title);
	return Response.json({ id: session.id, created_at: session.created_at }, { status: 201 });
}

function handleListSessions(url: URL, deps: ChatHandlerDeps): Response {
	const limit = Number(url.searchParams.get("limit")) || 50;
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const status = (url.searchParams.get("status") as "active" | "archived" | "deleted") ?? "active";
	const result = deps.sessionStore.list({ limit, cursor, status });
	return Response.json({ sessions: result.sessions, next_cursor: result.nextCursor });
}

async function handleFocusUpdate(req: Request, deps: ChatHandlerDeps): Promise<Response> {
	if (!deps.focusMap) return new Response(null, { status: 204 });
	let body: { session_id?: string; tab_id?: string; focused?: boolean } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return new Response(null, { status: 204 });
	}
	if (body.session_id) {
		deps.focusMap.updateFocus(body.session_id, body.tab_id ?? "default", body.focused ?? true);
	}
	return new Response(null, { status: 204 });
}

async function handlePushSubscribe(req: Request, deps: ChatHandlerDeps): Promise<Response> {
	if (!deps.db) return Response.json({ error: "Push not configured" }, { status: 503 });
	let body: { endpoint?: string; p256dh?: string; auth?: string; userAgent?: string } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	if (!body.endpoint || !body.p256dh || !body.auth) {
		return Response.json({ error: "endpoint, p256dh, and auth are required" }, { status: 400 });
	}
	if (!isValidPushEndpoint(body.endpoint)) {
		return Response.json({ error: "endpoint must be a valid https URL" }, { status: 400 });
	}
	subscribe(deps.db, {
		endpoint: body.endpoint,
		p256dh: body.p256dh,
		auth: body.auth,
		userAgent: body.userAgent,
	});
	return Response.json({ ok: true });
}

async function handlePushUnsubscribe(req: Request, deps: ChatHandlerDeps): Promise<Response> {
	if (!deps.db) return Response.json({ error: "Push not configured" }, { status: 503 });
	let body: { endpoint?: string } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	if (!body.endpoint) {
		return Response.json({ error: "endpoint is required" }, { status: 400 });
	}
	unsubscribe(deps.db, body.endpoint);
	return Response.json({ ok: true });
}

async function handlePushTest(deps: ChatHandlerDeps): Promise<Response> {
	if (!deps.db || !deps.vapidKeys) {
		return Response.json({ error: "Push not configured" }, { status: 503 });
	}
	const payload = testPayload(deps.agentName);
	const result = await broadcastNotification(deps.db, payload, deps.vapidKeys, deps.ownerEmail);
	return Response.json({ ok: true, sent: result.sent, failed: result.failed });
}

function serveManifest(agentName?: string): Response {
	const name = agentName && agentName.length > 0 ? agentName : "Phantom";
	const avatar = readAvatarMetaForManifest();
	const icons: Array<{ src: string; sizes: string; type: string; purpose: string }> = [];
	if (avatar) {
		icons.push({ src: "/chat/icon", sizes: "256x256", type: avatar.mime, purpose: "any" });
	}
	icons.push({ src: "/chat/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" });
	const manifest = {
		name,
		short_name: name,
		description: `${name} - AI co-worker`,
		id: "/chat/",
		start_url: "/chat/",
		scope: "/chat/",
		display: "standalone",
		background_color: "#faf9f5",
		theme_color: "#4850c4",
		icons,
	};
	return new Response(JSON.stringify(manifest), {
		headers: {
			"Content-Type": "application/manifest+json; charset=utf-8",
			"Cache-Control": "no-cache",
		},
	});
}
