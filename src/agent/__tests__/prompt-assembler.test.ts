import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhantomConfig } from "../../config/types.ts";
import { assemblePrompt } from "../prompt-assembler.ts";

const baseConfig: PhantomConfig = {
	name: "test-phantom",
	port: 3100,
	role: "swe",
	model: "claude-opus-4-6",
	provider: { type: "anthropic", secret_name: "provider_token" },
	secret_source: "env",
	effort: "max",
	max_budget_usd: 0,
	timeout_minutes: 240,
	permissions: { default_mode: "bypassPermissions", allow: [], deny: [] },
	evolution: { reflection_enabled: "auto", cadence_minutes: 180, demand_trigger_depth: 5 },
};

describe("assemblePrompt Docker awareness", () => {
	const origDockerEnv = process.env.PHANTOM_DOCKER;

	beforeEach(() => {
		process.env.PHANTOM_DOCKER = undefined;
	});

	afterEach(() => {
		process.env.PHANTOM_DOCKER = origDockerEnv;
	});

	test("bare metal mode uses VM language", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("dedicated virtual machine");
		expect(prompt).toContain("Hostname: test-phantom");
		expect(prompt).not.toContain("Docker container");
		expect(prompt).not.toContain("Docker-specific notes");
	});

	test("Docker mode uses container language when PHANTOM_DOCKER=true", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Docker container");
		expect(prompt).toContain("Container: phantom");
		expect(prompt).not.toContain("dedicated virtual machine");
	});

	test("Docker mode includes Docker-specific notes", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Docker-specific notes:");
		expect(prompt).toContain("sibling");
		expect(prompt).toContain("ClickHouse, Postgres, Redis");
		expect(prompt).toContain("Docker volumes");
		expect(prompt).toContain("http://qdrant:6333");
		expect(prompt).toContain("http://ollama:11434");
	});

	test("Docker mode warns agent not to modify compose/Dockerfile", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Do NOT modify docker-compose.yaml or Dockerfile");
	});

	test("non-Docker prompt still contains core capabilities", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Full Bash access");
		expect(prompt).toContain("Docker");
		expect(prompt).toContain("phantom_register_tool");
	});

	test("Docker prompt still contains core capabilities", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Full Bash access");
		expect(prompt).toContain("phantom_register_tool");
		expect(prompt).toContain("Security Boundaries");
	});
});

describe("assemblePrompt agent memory instructions", () => {
	test("includes the canonical agent-notes.md path", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("phantom-config/memory/agent-notes.md");
	});

	test("instructs the agent to append learnings via Write or Edit", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Write or Edit tool");
		expect(prompt).toContain("append-only");
	});

	test("teaches the agent when to write and when to skip", () => {
		const prompt = assemblePrompt(baseConfig);
		// Must cover the write triggers and the explicit do-not-write guardrails
		// so the agent does not log ephemeral task state or duplicate evolved config.
		expect(prompt).toContain("durable preference");
		expect(prompt).toContain("Do not write an entry for");
		expect(prompt).toContain("Ephemeral task state");
	});

	test("canonical agent-notes.md file is committed with a short header", () => {
		// The file is checked in as a baseline so the agent has something to
		// Edit on day one rather than having to Write a file it has never seen.
		const notesPath = join(process.cwd(), "phantom-config/memory/agent-notes.md");
		expect(existsSync(notesPath)).toBe(true);
		const content = readFileSync(notesPath, "utf-8");
		expect(content).toContain("# Agent notes");
		expect(content).toContain("append-only");
		// Header under 10 content lines keeps it scannable.
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		expect(lines.length).toBeLessThanOrEqual(10);
	});

	test("does not inject agent-notes.md file contents into the system prompt", () => {
		// The prompt block teaches the path and the rules but must NOT present
		// the file contents as canon. Reading the file is the agent's own job.
		// This guards against a future edit that accidentally wires the file
		// through a feedback loop that would drift the agent toward its own
		// past entries on every query.
		const prompt = assemblePrompt(baseConfig);
		// The file's placeholder header line must not appear in the assembled
		// prompt. If the future someone imports readFileSync here, this test
		// will fail loudly.
		expect(prompt).not.toContain("A running log of things the agent has learned about the operator");
	});
});

describe("assemblePrompt UI vocabulary guidance", () => {
	test("includes phantom-* vocabulary references", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("phantom-card");
		expect(prompt).toContain("phantom-stat");
		expect(prompt).toContain("phantom-table");
		expect(prompt).toContain("phantom-chat-bubble-user");
	});

	test("includes Instrument Serif font reference", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Instrument Serif");
	});

	test("includes the chart helper reference", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("window.phantomChart");
	});

	test("includes the self-validate phantom_preview_page guidance", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("phantom_preview_page");
	});

	test("references the living style guide and base template paths", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("public/_base.html");
		expect(prompt).toContain("/ui/_components.html");
	});

	test("references the eight reference example pages", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("public/_examples/");
	});
});
