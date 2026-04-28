import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool } from "../agent-sdk.ts";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BOUNDARY_FILE = "agent/agent-sdk.ts";

function listTypeScriptFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...listTypeScriptFiles(path));
		} else if (entry.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("Agent SDK boundary", () => {
	test("exposes the runtime symbols Phantom needs", () => {
		expect(typeof query).toBe("function");
		expect(typeof createSdkMcpServer).toBe("function");
		expect(typeof tool).toBe("function");
	});

	test("keeps direct Agent SDK imports isolated to the boundary module", () => {
		const offenders = listTypeScriptFiles(SRC_ROOT)
			.map((path) => ({ path, rel: relative(SRC_ROOT, path), source: readFileSync(path, "utf-8") }))
			.filter(({ rel }) => rel !== BOUNDARY_FILE)
			.filter(({ source }) => /from\s+["']@anthropic-ai\/claude-agent-sdk["']/.test(source))
			.map(({ rel }) => rel);

		expect(offenders).toEqual([]);
	});
});
