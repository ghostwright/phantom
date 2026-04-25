import { resolve as pathResolve } from "node:path";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { SlackTransport } from "../channels/slack-transport.ts";
import { handleEmailLogin } from "../chat/email-login.ts";
import type { PhantomConfig } from "../config/types.ts";
import { AuthMiddleware } from "../mcp/auth.ts";
import { loadMcpConfig } from "../mcp/config.ts";
import type { PhantomMcpServer } from "../mcp/server.ts";
import type { MemoryHealth } from "../memory/types.ts";
import type { SchedulerHealthSummary } from "../scheduler/health.ts";
import { avatarUrlIfPresent, handleAvatarGet } from "../ui/api/identity.ts";
import { getPublicDir, handleUiRequest } from "../ui/serve.ts";
import { type HealthPayload, renderHealthHtml } from "./health-page.ts";

const VERSION = "0.20.2";

type ChatHandler = (req: Request) => Promise<Response | null>;

type MemoryHealthProvider = () => Promise<MemoryHealth>;
type EvolutionVersionProvider = () => number;
type McpServerProvider = () => PhantomMcpServer | null;
type ChannelHealthProvider = () => Record<string, boolean>;
type RoleInfoProvider = () => { id: string; name: string } | null;
type OnboardingStatusProvider = () => string;
type WebhookHandler = (req: Request) => Promise<Response>;
type PeerHealthProvider = () => Record<string, { healthy: boolean; latencyMs: number; error?: string }>;
type SchedulerHealthProvider = () => SchedulerHealthSummary | null;
type TriggerDeps = {
	runtime: AgentRuntime;
	slackChannel?: SlackTransport;
	ownerUserId?: string;
};

let memoryHealthProvider: MemoryHealthProvider | null = null;
let evolutionVersionProvider: EvolutionVersionProvider | null = null;
let mcpServerProvider: McpServerProvider | null = null;
let channelHealthProvider: ChannelHealthProvider | null = null;
let roleInfoProvider: RoleInfoProvider | null = null;
let onboardingStatusProvider: OnboardingStatusProvider | null = null;
let webhookHandler: WebhookHandler | null = null;
let peerHealthProvider: PeerHealthProvider | null = null;
let schedulerHealthProvider: SchedulerHealthProvider | null = null;
let triggerDeps: TriggerDeps | null = null;
let chatHandler: ChatHandler | null = null;

export function setMemoryHealthProvider(provider: MemoryHealthProvider): void {
	memoryHealthProvider = provider;
}

export function setEvolutionVersionProvider(provider: EvolutionVersionProvider): void {
	evolutionVersionProvider = provider;
}

export function setMcpServerProvider(provider: McpServerProvider): void {
	mcpServerProvider = provider;
}

export function setChannelHealthProvider(provider: ChannelHealthProvider): void {
	channelHealthProvider = provider;
}

export function setRoleInfoProvider(provider: RoleInfoProvider): void {
	roleInfoProvider = provider;
}

export function setOnboardingStatusProvider(provider: OnboardingStatusProvider): void {
	onboardingStatusProvider = provider;
}

export function setWebhookHandler(handler: WebhookHandler): void {
	webhookHandler = handler;
}

export function setPeerHealthProvider(provider: PeerHealthProvider): void {
	peerHealthProvider = provider;
}

export function setSchedulerHealthProvider(provider: SchedulerHealthProvider): void {
	schedulerHealthProvider = provider;
}

export function setTriggerDeps(deps: TriggerDeps): void {
	triggerDeps = deps;
}

export function setChatHandler(handler: ChatHandler): void {
	chatHandler = handler;
}

let triggerAuth: AuthMiddleware | null = null;

// Content negotiation: return HTML only when the client accepts text/html.
// curl defaults to Accept: */* (no match), Docker healthcheck uses curl, MCP
// clients send application/json. Browsers lead with text/html.
function wantsHtml(acceptHeader: string | null): boolean {
	if (!acceptHeader) return false;
	return acceptHeader.toLowerCase().includes("text/html");
}

export function startServer(config: PhantomConfig, startedAt: number): ReturnType<typeof Bun.serve> {
	const mcpConfig = loadMcpConfig();
	triggerAuth = new AuthMiddleware(mcpConfig);

	const server = Bun.serve({
		port: config.port,
		async fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === "/health") {
				const memory: MemoryHealth = memoryHealthProvider
					? await memoryHealthProvider()
					: { qdrant: false, ollama: false, configured: false };

				const channels: Record<string, boolean> = channelHealthProvider ? channelHealthProvider() : {};

				const allHealthy = memory.qdrant && memory.ollama;
				const someHealthy = memory.qdrant || memory.ollama;
				// Both up -> ok. One up -> degraded. Both down + configured -> down. Not configured -> ok.
				const status = allHealthy ? "ok" : someHealthy ? "degraded" : memory.configured ? "down" : "ok";
				const evolutionGeneration = evolutionVersionProvider ? evolutionVersionProvider() : 0;

				const roleInfo = roleInfoProvider ? roleInfoProvider() : null;

				const onboardingStatus = onboardingStatusProvider ? onboardingStatusProvider() : null;
				const peers = peerHealthProvider ? peerHealthProvider() : null;
				const scheduler = schedulerHealthProvider ? schedulerHealthProvider() : null;

				const payload: HealthPayload = {
					status,
					uptime: Math.floor((Date.now() - startedAt) / 1000),
					version: VERSION,
					agent: config.name,
					avatar_url: avatarUrlIfPresent(),
					...(config.public_url ? { public_url: config.public_url } : {}),
					role: roleInfo ?? { id: config.role, name: config.role },
					channels,
					memory,
					evolution: { generation: evolutionGeneration },
					...(onboardingStatus ? { onboarding: onboardingStatus } : {}),
					...(peers && Object.keys(peers).length > 0 ? { peers } : {}),
					...(scheduler ? { scheduler } : {}),
				};

				// ?format=json overrides content negotiation so the HTML page can
				// re-fetch itself as JSON without juggling Accept headers.
				const formatOverride = url.searchParams.get("format");
				if (formatOverride !== "json" && req.method === "GET" && wantsHtml(req.headers.get("Accept"))) {
					return new Response(renderHealthHtml(payload), {
						headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
					});
				}

				return Response.json(payload);
			}

			if (url.pathname === "/mcp") {
				const mcpServer = mcpServerProvider?.();
				if (!mcpServer) {
					return Response.json(
						{ jsonrpc: "2.0", error: { code: -32603, message: "MCP server not initialized" }, id: null },
						{ status: 503 },
					);
				}
				return mcpServer.handleRequest(req);
			}

			if (url.pathname === "/trigger" && req.method === "POST") {
				return handleTrigger(req);
			}

			if (url.pathname === "/webhook") {
				if (!webhookHandler) {
					return Response.json({ status: "error", message: "Webhook channel not configured" }, { status: 503 });
				}
				return webhookHandler(req);
			}

			if (url.pathname === "/login/email" && req.method === "POST") {
				const publicUrl = config.public_url ?? `http://localhost:${config.port}`;
				return handleEmailLogin(req, publicUrl, config.name, config.domain ?? "ghostwright.dev");
			}

			// Public PWA/SW-scoped mirror of the operator avatar. Service
			// workers cannot reliably reach /ui/* across the /chat/ scope, so
			// we expose the same bytes under /chat/icon. Same headers as
			// /ui/avatar.
			if (url.pathname === "/chat/icon" && req.method === "GET") {
				return handleAvatarGet(req);
			}
			if (url.pathname === "/chat/icon") {
				return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
			}

			if (url.pathname.startsWith("/chat") && chatHandler) {
				const response = await chatHandler(req);
				if (response) return response;
			}

			// Public publishing surface. Agents drop HTML, XML, or assets
			// under public/public/*. Served without auth so Googlebot,
			// OpenGraph scrapers, and the open web can read them.
			// Traversal-defended via path.resolve + containment check.
			if (url.pathname === "/public" || url.pathname === "/public/" || url.pathname.startsWith("/public/")) {
				return handlePublicRequest(url);
			}

			if (url.pathname.startsWith("/ui")) {
				return handleUiRequest(req);
			}

			if (url.pathname === "/" || url.pathname === "") {
				return Response.redirect("/ui/", 302);
			}

			return Response.json({ error: "Not found" }, { status: 404 });
		},
	});

	console.log(`[phantom] HTTP server listening on port ${config.port}`);
	return server;
}

async function handlePublicRequest(url: URL): Promise<Response> {
	const publicRoot = pathResolve(getPublicDir(), "public");
	const isRoot = url.pathname === "/public" || url.pathname === "/public/";
	const rawRel = isRoot ? "index.html" : url.pathname.slice("/public/".length);
	// Decode percent-escapes so traversal sequences like ..%2F become visible
	// to the containment check below. A malformed escape is rejected outright.
	let rel: string;
	try {
		rel = decodeURIComponent(rawRel);
	} catch {
		return new Response("Forbidden", { status: 403 });
	}
	if (rel.includes("\0")) {
		return new Response("Forbidden", { status: 403 });
	}
	const candidate = pathResolve(publicRoot, rel);
	if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}/`)) {
		return new Response("Forbidden", { status: 403 });
	}
	const file = Bun.file(candidate);
	if (await file.exists()) {
		return new Response(file, {
			headers: { "Cache-Control": "public, max-age=300" },
		});
	}
	// Directory-style index.html fallback (e.g. /public/blog/ -> public/public/blog/index.html)
	const indexCandidate = pathResolve(candidate, "index.html");
	if (indexCandidate !== candidate && indexCandidate.startsWith(`${publicRoot}/`)) {
		const indexFile = Bun.file(indexCandidate);
		if (await indexFile.exists()) {
			return new Response(indexFile, {
				headers: { "Cache-Control": "public, max-age=300" },
			});
		}
	}
	return new Response("Not found", { status: 404 });
}

async function handleTrigger(req: Request): Promise<Response> {
	if (!triggerAuth) {
		return Response.json({ status: "error", message: "Auth not initialized" }, { status: 503 });
	}

	const auth = await triggerAuth.authenticate(req);
	if (!auth.authenticated) {
		return Response.json({ status: "error", message: auth.error }, { status: 401 });
	}

	if (!triggerAuth.hasScope(auth, "operator")) {
		return Response.json({ status: "error", message: "Insufficient scope: operator required" }, { status: 403 });
	}

	if (!triggerDeps) {
		return Response.json({ status: "error", message: "Trigger not configured" }, { status: 503 });
	}

	let body: { task?: string; delivery?: { channel?: string; target?: string }; source?: string };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ status: "error", message: "Invalid JSON body" }, { status: 400 });
	}

	if (!body.task || typeof body.task !== "string") {
		return Response.json({ status: "error", message: "Missing required field: task" }, { status: 400 });
	}

	const conversationId = `trigger:${crypto.randomUUID()}`;
	const source = body.source ?? "http";

	try {
		const response = await triggerDeps.runtime.handleMessage("trigger", conversationId, body.task);

		// Deliver via Slack if requested
		const deliveryChannel = body.delivery?.channel ?? "slack";
		const deliveryTarget = body.delivery?.target ?? "owner";

		if (deliveryChannel === "slack" && triggerDeps.slackChannel) {
			if (deliveryTarget === "owner" && triggerDeps.ownerUserId) {
				await triggerDeps.slackChannel.sendDm(triggerDeps.ownerUserId, response.text);
			} else if (deliveryTarget.startsWith("C")) {
				await triggerDeps.slackChannel.postToChannel(deliveryTarget, response.text);
			} else if (deliveryTarget.startsWith("U")) {
				await triggerDeps.slackChannel.sendDm(deliveryTarget, response.text);
			}
		}

		return Response.json({
			status: "ok",
			source,
			conversationId,
			response: response.text,
			cost: response.cost.totalUsd,
			durationMs: response.durationMs,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ status: "error", message: msg }, { status: 500 });
	}
}
