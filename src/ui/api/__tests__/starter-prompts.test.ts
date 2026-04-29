// Tests for GET /ui/api/starter-prompts.
//
// The endpoint is public (no cookie gate) so most tests call handleUiRequest
// with no Cookie header. Schema and fallback paths exercise the YAML loader
// directly via the config-dir test seam.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleUiRequest, setPublicDir } from "../../serve.ts";
import { DEFAULT_STARTER_PROMPTS, loadStarterPrompts } from "../../starter-prompts.ts";
import { setStarterPromptsConfigDirForTests } from "../starter-prompts.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let tmpDir: string;
let warnings: string[];
const originalWarn = console.warn;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "phantom-starter-prompts-"));
	setStarterPromptsConfigDirForTests(tmpDir);
	warnings = [];
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
	};
});

afterEach(() => {
	setStarterPromptsConfigDirForTests(null);
	rmSync(tmpDir, { recursive: true, force: true });
	console.warn = originalWarn;
});

function writeYaml(contents: string): void {
	writeFileSync(join(tmpDir, "starter-prompts.yaml"), contents, "utf-8");
}

function get(): Request {
	return new Request("http://localhost/ui/api/starter-prompts", { method: "GET" });
}

describe("GET /ui/api/starter-prompts", () => {
	test("returns defaults when the YAML is absent", async () => {
		const res = await handleUiRequest(get());
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
		const body = (await res.json()) as { tiles: { title: string }[] };
		expect(body.tiles.length).toBe(DEFAULT_STARTER_PROMPTS.length);
		expect(body.tiles[0].title).toBe("Summarize Hacker News");
		expect(warnings.length).toBe(0);
	});

	test("returns YAML override tiles in order", async () => {
		writeYaml(
			"tiles:\n  - icon: chart\n    title: Custom A\n    description: First tile.\n    prompt: Do A.\n  - icon: git\n    title: Custom B\n    description: Second tile.\n    prompt: Do B.\n",
		);
		const res = await handleUiRequest(get());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tiles: { title: string }[] };
		expect(body.tiles.length).toBe(2);
		expect(body.tiles[0].title).toBe("Custom A");
		expect(body.tiles[1].title).toBe("Custom B");
	});

	test("malformed YAML logs a warning and returns defaults", async () => {
		writeYaml("tiles:\n  - icon: chart\n    title: [unclosed");
		const res = await handleUiRequest(get());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tiles: unknown[] };
		expect(body.tiles.length).toBe(DEFAULT_STARTER_PROMPTS.length);
		expect(warnings.some((w) => w.includes("invalid YAML"))).toBe(true);
	});

	test("schema-invalid YAML returns defaults and logs the field", async () => {
		writeYaml("tiles:\n  - icon: chart\n    title: Missing prompt\n    description: no prompt field.\n");
		const res = await handleUiRequest(get());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tiles: unknown[] };
		expect(body.tiles.length).toBe(DEFAULT_STARTER_PROMPTS.length);
		expect(warnings.some((w) => w.includes("schema rejected"))).toBe(true);
	});

	test("unknown top-level key fails strict() and returns defaults", async () => {
		writeYaml("tiles:\n  - icon: chart\n    title: OK\n    description: fine.\n    prompt: fine.\nextra: nope\n");
		const res = await handleUiRequest(get());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tiles: unknown[] };
		expect(body.tiles.length).toBe(DEFAULT_STARTER_PROMPTS.length);
		expect(warnings.some((w) => w.includes("schema rejected"))).toBe(true);
	});

	test("over-long title rejects schema and returns defaults", async () => {
		const longTitle = "x".repeat(81);
		writeYaml(`tiles:\n  - icon: chart\n    title: "${longTitle}"\n    description: short.\n    prompt: short.\n`);
		const res = await handleUiRequest(get());
		const body = (await res.json()) as { tiles: unknown[] };
		expect(body.tiles.length).toBe(DEFAULT_STARTER_PROMPTS.length);
		expect(warnings.some((w) => w.includes("schema rejected"))).toBe(true);
	});

	test("more than six tiles rejects schema and returns defaults", async () => {
		const seven = Array.from({ length: 7 })
			.map((_, i) => `  - icon: chart\n    title: Tile ${i}\n    description: d${i}.\n    prompt: p${i}.\n`)
			.join("");
		writeYaml(`tiles:\n${seven}`);
		const res = await handleUiRequest(get());
		const body = (await res.json()) as { tiles: unknown[] };
		expect(body.tiles.length).toBe(DEFAULT_STARTER_PROMPTS.length);
	});

	test("POST returns 405 with Allow: GET", async () => {
		const res = await handleUiRequest(new Request("http://localhost/ui/api/starter-prompts", { method: "POST" }));
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});

	test("endpoint is public (no cookie required)", async () => {
		const res = await handleUiRequest(get());
		expect(res.status).toBe(200);
	});

	test("loadStarterPrompts returns a fresh copy (callers can mutate safely)", () => {
		const a = loadStarterPrompts(tmpDir);
		const b = loadStarterPrompts(tmpDir);
		expect(a).not.toBe(b);
		expect(a[0]).not.toBe(b[0]);
	});
});
