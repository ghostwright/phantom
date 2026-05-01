import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhantomConfig } from "../../config/types.ts";
import { assemblePrompt } from "../prompt-assembler.ts";

const baseConfig: PhantomConfig = {
	name: "test-phantom",
	port: 3100,
	role: "swe",
	agent_runtime: "anthropic",
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

describe("assemblePrompt tenant self-knowledge overlay", () => {
	const SELF_KNOWLEDGE_ENV_KEYS = [
		"PHANTOM_TENANT_SLUG",
		"PHANTOM_TENANT_ID",
		"PHANTOM_OWNER_EMAIL",
		"PHANTOM_OWNER_NAME",
		"PHANTOM_DOMAIN",
		"PHANTOM_DASHBOARD_URL",
		"PHANTOM_AGENT_RUNTIME",
		"PHANTOM_MODEL",
		"PHANTOM_GRANTED_INTEGRATIONS",
		"PHANTOM_CHANNEL_ALLOWLIST",
	] as const;

	const originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Snapshot every key we plan to touch so we can restore exactly
		// what the surrounding process saw before we start mutating env.
		for (const key of SELF_KNOWLEDGE_ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		// Restore. Using the snapshot is more conservative than blanket
		// delete because the process running the tests may have its own
		// values for these keys (e.g. a tenant-aware dev shell).
		for (const key of SELF_KNOWLEDGE_ENV_KEYS) {
			const original = originalEnv[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	test("omits the overlay entirely when no tenant env vars are set", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).not.toContain("# Who You Are In This Workspace");
	});

	test("injects the overlay between Identity and Environment when tenant env is present", () => {
		process.env.PHANTOM_TENANT_SLUG = "gilded-hearth";
		process.env.PHANTOM_OWNER_EMAIL = "cheema@example.com";
		process.env.PHANTOM_OWNER_NAME = "Cheema";
		process.env.PHANTOM_DOMAIN = "gilded-hearth.phantom.ghostwright.dev";
		process.env.PHANTOM_DASHBOARD_URL = "https://app.ghostwright.dev";
		process.env.PHANTOM_AGENT_RUNTIME = "murph";
		process.env.PHANTOM_MODEL = "claude-sonnet-4-6";

		const prompt = assemblePrompt(baseConfig);
		const identityIdx = prompt.indexOf("autonomous AI co-worker");
		const overlayIdx = prompt.indexOf("# Who You Are In This Workspace");
		const environmentIdx = prompt.indexOf("# Your Environment");

		expect(identityIdx).toBeGreaterThanOrEqual(0);
		expect(overlayIdx).toBeGreaterThan(identityIdx);
		expect(environmentIdx).toBeGreaterThan(overlayIdx);

		// The overlay carries the cardinal facts.
		expect(prompt).toContain(
			"You are the Phantom assigned to Cheema (cheema@example.com)'s workspace `gilded-hearth`.",
		);
		expect(prompt).toContain("Your home URL is https://gilded-hearth.phantom.ghostwright.dev.");
		expect(prompt).toContain("Your dashboard control surface is https://app.ghostwright.dev.");
		expect(prompt).toContain("Runtime: murph.");
		expect(prompt).toContain("Model: claude-sonnet-4-6.");
	});

	test("renders the overlay with only the slug + dashboard set (defensive shape)", () => {
		// Intermediate phantomd versions inject only PHANTOM_TENANT_SLUG +
		// PHANTOM_OWNER_EMAIL today. The overlay must still produce a
		// useful block in that interim shape so the agent gets self-
		// knowledge as soon as ANY tenant signal is present.
		process.env.PHANTOM_TENANT_SLUG = "gilded-hearth";
		process.env.PHANTOM_OWNER_EMAIL = "cheema@example.com";
		process.env.PHANTOM_DASHBOARD_URL = "https://ghostwright.dev/phantom/dashboard";

		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("# Who You Are In This Workspace");
		expect(prompt).toContain("You are the Phantom assigned to cheema@example.com's workspace `gilded-hearth`.");
		// Without PHANTOM_DOMAIN the home URL falls back to the wildcard
		// derivation from the slug.
		expect(prompt).toContain("Your home URL is https://gilded-hearth.phantom.ghostwright.dev.");
		expect(prompt).toContain("Your dashboard control surface is https://ghostwright.dev/phantom/dashboard.");
		// No runtime or model line should appear.
		expect(prompt).not.toContain("Runtime:");
		expect(prompt).not.toContain("Model:");
	});

	test("surfaces granted integrations and channel allowlist when phantomd emits them", () => {
		// Phase 7 + Phase 8b will start emitting these lists; the overlay
		// has to render them today so the system prompt does not need a
		// second round of changes when those phases ship.
		process.env.PHANTOM_TENANT_SLUG = "gilded-hearth";
		process.env.PHANTOM_OWNER_EMAIL = "cheema@example.com";
		process.env.PHANTOM_GRANTED_INTEGRATIONS = "github,linear,notion";
		process.env.PHANTOM_CHANNEL_ALLOWLIST = "C0123,C0456";

		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("You have been granted these integrations: github, linear, notion.");
		expect(prompt).toContain("Your Slack channel allowlist: C0123, C0456.");
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

	test("distinguishes created page URLs from authentication links", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Page URLs and login URLs are different.");
		expect(prompt).toContain("return the exact /ui/<path> page URL");
		expect(prompt).toContain("Only call phantom_generate_login");
		expect(prompt).toContain("Do not substitute");
	});
});
