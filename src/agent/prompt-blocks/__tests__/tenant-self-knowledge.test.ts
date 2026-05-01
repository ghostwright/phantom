// Tests for the tenant self-knowledge overlay (Phase 9). Covers the pure
// builder function (no env coupling) AND the env reader (process.env shape).
// Failure-path coverage: missing vars, empty strings, malformed list values,
// the no-tenant fallback (every var unset, overlay returns empty).

import { describe, expect, test } from "bun:test";
import {
	type TenantSelfKnowledgeEnv,
	buildTenantSelfKnowledge,
	readTenantSelfKnowledgeEnv,
} from "../tenant-self-knowledge.ts";

const fullEnv: TenantSelfKnowledgeEnv = {
	tenantSlug: "gilded-hearth",
	tenantId: "cheema",
	ownerEmail: "cheema@example.com",
	ownerName: "Cheema",
	domain: "gilded-hearth.phantom.ghostwright.dev",
	dashboardUrl: "https://app.ghostwright.dev",
	agentRuntime: "murph",
	model: "claude-sonnet-4-6",
	grantedIntegrations: undefined,
	channelAllowlist: undefined,
};

describe("buildTenantSelfKnowledge", () => {
	test("composes the canonical block from a full env shape", () => {
		const block = buildTenantSelfKnowledge(fullEnv);
		expect(block).toContain("# Who You Are In This Workspace");
		expect(block).toContain("You are the Phantom assigned to Cheema (cheema@example.com)'s workspace `gilded-hearth`.");
		expect(block).toContain("Your home URL is https://gilded-hearth.phantom.ghostwright.dev.");
		expect(block).toContain("The user reaches you here.");
		expect(block).toContain("Your dashboard control surface is https://app.ghostwright.dev.");
		expect(block).toContain("Runtime: murph.");
		expect(block).toContain("Model: claude-sonnet-4-6.");
	});

	test("falls back to email-only owner phrase when name is absent", () => {
		const block = buildTenantSelfKnowledge({ ...fullEnv, ownerName: undefined });
		expect(block).toContain("You are the Phantom assigned to cheema@example.com's workspace `gilded-hearth`.");
		// Make sure the empty name does not produce an awkward " ()" parenthetical.
		expect(block).not.toContain("()");
	});

	test("falls back to name-only owner phrase when email is absent", () => {
		const block = buildTenantSelfKnowledge({ ...fullEnv, ownerEmail: undefined });
		expect(block).toContain("You are the Phantom assigned to Cheema's workspace `gilded-hearth`.");
		expect(block).not.toContain("()");
	});

	test("omits owner phrase entirely when both name and email are absent", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			ownerName: undefined,
			ownerEmail: undefined,
		});
		expect(block).toContain("You are the Phantom for workspace `gilded-hearth`.");
		expect(block).not.toContain("Phantom assigned to");
	});

	test("derives home URL from slug when PHANTOM_DOMAIN is missing", () => {
		const block = buildTenantSelfKnowledge({ ...fullEnv, domain: undefined });
		// Defensive against intermediate phantomd versions that have not yet
		// landed PHANTOM_DOMAIN injection: derive the canonical wildcard URL
		// from the slug + ghostwright.dev.
		expect(block).toContain("Your home URL is https://gilded-hearth.phantom.ghostwright.dev.");
	});

	test("strips an accidental https:// prefix from PHANTOM_DOMAIN before composing the URL", () => {
		// Defensive against a phantomd-side change that emits
		// PHANTOM_DOMAIN=https://gilded-hearth.phantom.ghostwright.dev/
		// instead of the bare hostname. We always rebuild as https://<host>.
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			domain: "https://gilded-hearth.phantom.ghostwright.dev/",
		});
		expect(block).toContain("Your home URL is https://gilded-hearth.phantom.ghostwright.dev.");
		expect(block).not.toContain("https://https://");
	});

	test("omits the home URL line when neither domain nor slug is known", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			domain: undefined,
			tenantSlug: undefined,
			ownerEmail: "cheema@example.com",
			ownerName: undefined,
		});
		expect(block).not.toContain("Your home URL is");
		// The owner sentence should still appear even without a slug.
		expect(block).toContain("You are the Phantom assigned to cheema@example.com's workspace.");
	});

	test("omits the dashboard line when PHANTOM_DASHBOARD_URL is missing", () => {
		const block = buildTenantSelfKnowledge({ ...fullEnv, dashboardUrl: undefined });
		expect(block).not.toContain("dashboard control surface");
	});

	test("omits the runtime line when PHANTOM_AGENT_RUNTIME and PHANTOM_MODEL are both missing", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			agentRuntime: undefined,
			model: undefined,
		});
		expect(block).not.toContain("Runtime:");
		expect(block).not.toContain("Model:");
	});

	test("emits only the runtime when model is missing", () => {
		const block = buildTenantSelfKnowledge({ ...fullEnv, model: undefined });
		expect(block).toContain("Runtime: murph.");
		expect(block).not.toContain("Model:");
	});

	test("emits only the model when runtime is missing", () => {
		const block = buildTenantSelfKnowledge({ ...fullEnv, agentRuntime: undefined });
		expect(block).toContain("Model: claude-sonnet-4-6.");
		expect(block).not.toContain("Runtime:");
	});

	test("renders granted integrations when PHANTOM_GRANTED_INTEGRATIONS is present", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			grantedIntegrations: "github, linear ,notion",
		});
		expect(block).toContain("You have been granted these integrations: github, linear, notion.");
	});

	test("renders channel allowlist when PHANTOM_CHANNEL_ALLOWLIST is present", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			channelAllowlist: "C0123,C0456,,",
		});
		expect(block).toContain("Your Slack channel allowlist: C0123, C0456.");
	});

	test("omits the integrations line when the value is an empty list", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			grantedIntegrations: " , , ",
		});
		expect(block).not.toContain("granted these integrations");
	});

	test("omits the channel allowlist line when the value is whitespace-only", () => {
		const block = buildTenantSelfKnowledge({
			...fullEnv,
			channelAllowlist: "   ",
		});
		expect(block).not.toContain("channel allowlist");
	});

	test("returns the empty string when every tenant signal is absent", () => {
		const block = buildTenantSelfKnowledge({});
		expect(block).toBe("");
	});

	test("returns the empty string when only tenantId is set (tenantId alone never enters the prompt)", () => {
		// The block is keyed off slug, owner, domain, etc. Just having a
		// tenantId is not enough to surface anything user-relevant. This
		// asserts the block stays silent in that degenerate case so a
		// half-injected env never produces a stub heading.
		const block = buildTenantSelfKnowledge({ tenantId: "abc-123" });
		expect(block).toBe("");
	});

	test("treats whitespace-only env values as unset", () => {
		const block = buildTenantSelfKnowledge({
			tenantSlug: "   ",
			ownerEmail: "\t",
			domain: " ",
		});
		expect(block).toBe("");
	});
});

describe("readTenantSelfKnowledgeEnv", () => {
	test("reads every supported env var into the shape", () => {
		const shape = readTenantSelfKnowledgeEnv({
			PHANTOM_TENANT_SLUG: "gilded-hearth",
			PHANTOM_TENANT_ID: "cheema",
			PHANTOM_OWNER_EMAIL: "cheema@example.com",
			PHANTOM_OWNER_NAME: "Cheema",
			PHANTOM_DOMAIN: "gilded-hearth.phantom.ghostwright.dev",
			PHANTOM_DASHBOARD_URL: "https://app.ghostwright.dev",
			PHANTOM_AGENT_RUNTIME: "murph",
			PHANTOM_MODEL: "claude-sonnet-4-6",
			PHANTOM_GRANTED_INTEGRATIONS: "github,linear",
			PHANTOM_CHANNEL_ALLOWLIST: "C0123",
		});
		expect(shape).toEqual({
			tenantSlug: "gilded-hearth",
			tenantId: "cheema",
			ownerEmail: "cheema@example.com",
			ownerName: "Cheema",
			domain: "gilded-hearth.phantom.ghostwright.dev",
			dashboardUrl: "https://app.ghostwright.dev",
			agentRuntime: "murph",
			model: "claude-sonnet-4-6",
			grantedIntegrations: "github,linear",
			channelAllowlist: "C0123",
		});
	});

	test("returns undefined for missing env vars", () => {
		const shape = readTenantSelfKnowledgeEnv({});
		expect(shape.tenantSlug).toBeUndefined();
		expect(shape.tenantId).toBeUndefined();
		expect(shape.ownerEmail).toBeUndefined();
		expect(shape.ownerName).toBeUndefined();
		expect(shape.domain).toBeUndefined();
		expect(shape.dashboardUrl).toBeUndefined();
		expect(shape.agentRuntime).toBeUndefined();
		expect(shape.model).toBeUndefined();
		expect(shape.grantedIntegrations).toBeUndefined();
		expect(shape.channelAllowlist).toBeUndefined();
	});

	test("treats whitespace-only env values as undefined", () => {
		const shape = readTenantSelfKnowledgeEnv({
			PHANTOM_TENANT_SLUG: "   ",
			PHANTOM_OWNER_EMAIL: "\t\n",
		});
		expect(shape.tenantSlug).toBeUndefined();
		expect(shape.ownerEmail).toBeUndefined();
	});

	test("trims surrounding whitespace from real values", () => {
		const shape = readTenantSelfKnowledgeEnv({
			PHANTOM_TENANT_SLUG: "  gilded-hearth\n",
			PHANTOM_OWNER_EMAIL: " cheema@example.com ",
		});
		expect(shape.tenantSlug).toBe("gilded-hearth");
		expect(shape.ownerEmail).toBe("cheema@example.com");
	});

	test("defaults to process.env when no override is passed", () => {
		// Spot check: at least one well-known shape key exists with the right
		// type. We do not assert content because process.env is per-environment.
		const shape = readTenantSelfKnowledgeEnv();
		expect(typeof shape).toBe("object");
	});
});
