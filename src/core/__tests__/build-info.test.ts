import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";
import { readBuildInfo } from "../build-info.ts";
import { startServer } from "../server.ts";

/**
 * Phase 18 PR-6: end-to-end coverage for the /health/build-info surface.
 *
 * The endpoint reads a JSON file at `/etc/phantom-build-info` (or whatever
 * `PHANTOM_BUILD_INFO_PATH` points at). Tests redirect the path at a tmp
 * file so they never touch /etc.
 */
describe("readBuildInfo", () => {
	let tmpDir: string;
	let path: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "phantom-build-info-"));
		path = join(tmpDir, "build-info");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns parsed JSON when the file exists", async () => {
		const payload = {
			schema_version: 1,
			phantom_ref_requested: "main",
			phantom_ref_resolved: "abc1234",
			phantom_sha: "abc1234deadbeef0000000000000000000000ff",
			phantom_built_at: "2026-05-01T12:00:00Z",
			rootfs_image_name: "phantom-rootfs",
		};
		writeFileSync(path, JSON.stringify(payload), "utf-8");

		const result = await readBuildInfo(path);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.parsed).toEqual(payload);
		expect(result.raw).toBe(JSON.stringify(payload));
	});

	test("returns missing when the file is absent", async () => {
		const result = await readBuildInfo(join(tmpDir, "does-not-exist"));
		expect(result.kind).toBe("missing");
	});

	test("returns malformed when the file is not JSON", async () => {
		writeFileSync(path, "not json{", "utf-8");
		const result = await readBuildInfo(path);
		expect(result.kind).toBe("malformed");
	});

	test("returns malformed when the file is JSON but not an object", async () => {
		writeFileSync(path, JSON.stringify(["array", "instead"]), "utf-8");
		const result = await readBuildInfo(path);
		expect(result.kind).toBe("malformed");
	});
});

describe("GET /health/build-info", () => {
	const mcpConfigPath = "config/mcp.yaml";
	let originalMcpYaml: string | null = null;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let tmpDir: string;
	let path: string;
	let originalEnv: string | undefined;

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

		server = startServer({ name: "phantom", port: 0, role: "base" } as never, Date.now());
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server?.stop(true);
		if (originalMcpYaml !== null) {
			writeFileSync(mcpConfigPath, originalMcpYaml, "utf-8");
		}
	});

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "phantom-build-info-route-"));
		path = join(tmpDir, "build-info");
		originalEnv = process.env.PHANTOM_BUILD_INFO_PATH;
		process.env.PHANTOM_BUILD_INFO_PATH = path;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			// biome-ignore lint/performance/noDelete: tests must actually unset the env to exercise the default-path branch
			delete process.env.PHANTOM_BUILD_INFO_PATH;
		} else {
			process.env.PHANTOM_BUILD_INFO_PATH = originalEnv;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("200 with the file's JSON when build-info exists", async () => {
		const payload = {
			schema_version: 1,
			phantom_ref_requested: "v0.20.2",
			phantom_ref_resolved: "abc1234",
			phantom_sha: "abc1234deadbeef0000000000000000000000ff",
			phantom_built_at: "2026-05-01T12:00:00Z",
			murph_ref_requested: "main",
			murph_ref_resolved: "def5678",
			murph_sha: "def5678cafef00d00000000000000000000baad",
			rootfs_image_name: "phantom-rootfs",
			dockerfile_sha: "fedcba0987654321",
		};
		writeFileSync(path, JSON.stringify(payload), "utf-8");

		const res = await fetch(`${baseUrl}/health/build-info`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/json");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual(payload);
		expect(body.schema_version).toBe(1);
		expect(typeof body.schema_version).toBe("number");
	});

	test("404 with a clean error when the file is missing", async () => {
		const res = await fetch(`${baseUrl}/health/build-info`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("build_info_unavailable");
	});

	test("500 when the file is present but malformed", async () => {
		writeFileSync(path, "{not json", "utf-8");
		const res = await fetch(`${baseUrl}/health/build-info`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("build_info_malformed");
	});

	test("reads at request-time so an in-place file overwrite is reflected on the next request", async () => {
		writeFileSync(path, JSON.stringify({ schema_version: 1, phantom_sha: "first" }), "utf-8");
		let res = await fetch(`${baseUrl}/health/build-info`);
		expect(res.status).toBe(200);
		let body = (await res.json()) as { phantom_sha: string };
		expect(body.phantom_sha).toBe("first");

		writeFileSync(path, JSON.stringify({ schema_version: 1, phantom_sha: "second" }), "utf-8");
		res = await fetch(`${baseUrl}/health/build-info`);
		expect(res.status).toBe(200);
		body = (await res.json()) as { phantom_sha: string };
		expect(body.phantom_sha).toBe("second");
	});

	test("POST /health/build-info returns 404 (read-only contract)", async () => {
		writeFileSync(path, JSON.stringify({ schema_version: 1 }), "utf-8");
		const res = await fetch(`${baseUrl}/health/build-info`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});
