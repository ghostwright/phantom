import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { setSlackHttpChannelProvider } from "../../channels/slack-http-routes.ts";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";
import { startServer } from "../server.ts";

/**
 * Pin Bug A's port-collision fix end-to-end. Before this fix, an inbound
 * `POST /slack/events` to the Phantom Bun.serve port returned 404 because
 * the slack channel tried to bind a second HTTP server to the same port,
 * failed, and never mounted the routes. After the fix, the routes are
 * mounted on the existing Bun.serve and a stub channel handles them.
 *
 * The stub channel here is shaped exactly like the SlackHttpChannel
 * surface that `tryHandleSlackHttp` calls into: handleEvent,
 * handleInteractivity, handleCommand. We do NOT instantiate Bolt; the
 * goal is to prove the route is alive and the handler is reachable.
 */
describe("server slack-http routing", () => {
	const mcpConfigPath = "config/mcp.yaml";
	let originalMcpYaml: string | null = null;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	const calls: Array<{ method: string; path: string }> = [];
	const stub = {
		async handleEvent(req: Request): Promise<Response> {
			calls.push({ method: req.method, path: new URL(req.url).pathname });
			return new Response("event-ok", { status: 200 });
		},
		async handleInteractivity(req: Request): Promise<Response> {
			calls.push({ method: req.method, path: new URL(req.url).pathname });
			return new Response("interactivity-ok", { status: 200 });
		},
		async handleCommand(req: Request): Promise<Response> {
			calls.push({ method: req.method, path: new URL(req.url).pathname });
			return new Response("command-ok", { status: 200 });
		},
	};

	beforeAll(() => {
		if (existsSync(mcpConfigPath)) {
			originalMcpYaml = readFileSync(mcpConfigPath, "utf-8");
		}
		const mcpConfig: McpConfig = {
			tokens: [{ name: "admin", hash: hashTokenSync("test-admin"), scopes: ["read", "operator", "admin"] }],
			rate_limit: { requests_per_minute: 60, burst: 10 },
		};
		mkdirSync("config", { recursive: true });
		writeFileSync(mcpConfigPath, YAML.stringify(mcpConfig), "utf-8");

		// `setSlackHttpChannelProvider` accepts a SlackHttpChannel; the stub
		// matches the structural shape `tryHandleSlackHttp` invokes and is
		// cast via `as never` ONLY at the test boundary so the test can stay
		// hermetic without spinning up a real Bolt App + auth.test.
		setSlackHttpChannelProvider(() => stub as never);

		server = startServer({ name: "phantom", port: 0, role: "base" } as never, Date.now());
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server?.stop(true);
		setSlackHttpChannelProvider(() => null);
		if (originalMcpYaml !== null) {
			writeFileSync(mcpConfigPath, originalMcpYaml, "utf-8");
		}
	});

	test("POST /slack/events reaches the channel handler", async () => {
		calls.length = 0;
		const res = await fetch(`${baseUrl}/slack/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"team_id":"T1"}',
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("event-ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/slack/events");
	});

	test("POST /slack/interactivity reaches the channel handler", async () => {
		calls.length = 0;
		const res = await fetch(`${baseUrl}/slack/interactivity`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "payload=%7B%7D",
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("interactivity-ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/slack/interactivity");
	});

	test("POST /slack/commands reaches the channel handler", async () => {
		calls.length = 0;
		const res = await fetch(`${baseUrl}/slack/commands`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "team_id=T1&command=%2Fphantom",
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("command-ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/slack/commands");
	});

	test("GET /slack/events returns 405 (POST-only ingress)", async () => {
		const res = await fetch(`${baseUrl}/slack/events`);
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});

	test("POST /slack/unknown is not a slack route and falls through to 404", async () => {
		const res = await fetch(`${baseUrl}/slack/unknown`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("POST /slack/events with no channel provider returns 503", async () => {
		setSlackHttpChannelProvider(() => null);
		try {
			const res = await fetch(`${baseUrl}/slack/events`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(503);
		} finally {
			setSlackHttpChannelProvider(() => stub as never);
		}
	});
});
