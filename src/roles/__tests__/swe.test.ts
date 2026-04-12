import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadRoleFromYaml } from "../loader.ts";

const ROLES_DIR = resolve("config/roles");

describe("SWE Role", () => {
	test("loads the SWE role from config/roles/swe.yaml", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.id).toBe("swe");
		expect(swe.name).toBe("Software Engineer");
	});

	test("has the correct identity", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.identity).toContain("software engineer");
		expect(swe.identity).toContain("production-ready");
	});

	test("has all required capabilities", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.capabilities.length).toBeGreaterThanOrEqual(5);
		expect(swe.capabilities.some((c) => c.toLowerCase().includes("code"))).toBe(true);
		expect(swe.capabilities.some((c) => c.toLowerCase().includes("review"))).toBe(true);
		expect(swe.capabilities.some((c) => c.toLowerCase().includes("debug"))).toBe(true);
	});

	test("has 6 onboarding questions", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.onboarding_questions).toHaveLength(6);

		const ids = swe.onboarding_questions.map((q) => q.id);
		expect(ids).toContain("repos");
		expect(ids).toContain("tech_stack");
		expect(ids).toContain("work_management");
		expect(ids).toContain("ci_cd");
		expect(ids).toContain("pr_conventions");
		expect(ids).toContain("coding_conventions");
	});

	test("repos question is required", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);
		const repos = swe.onboarding_questions.find((q) => q.id === "repos");

		expect(repos).toBeDefined();
		expect(repos?.required).toBe(true);
		expect(repos?.type).toBe("multiline");
	});

	test("has 6 MCP tool definitions", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.mcp_tools).toHaveLength(6);

		const toolNames = swe.mcp_tools.map((t) => t.name);
		expect(toolNames).toContain("phantom_codebase_query");
		expect(toolNames).toContain("phantom_pr_status");
		expect(toolNames).toContain("phantom_ci_status");
		expect(toolNames).toContain("phantom_review_request");
		expect(toolNames).toContain("phantom_deploy_status");
		expect(toolNames).toContain("phantom_repo_info");
	});

	test("has the correct evolution focus priorities", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.evolution_focus.priorities).toContain("coding_patterns");
		expect(swe.evolution_focus.priorities).toContain("ci_failures");
		expect(swe.evolution_focus.priorities).toContain("review_feedback");
		expect(swe.evolution_focus.priorities).toContain("codebase_knowledge");
		expect(swe.evolution_focus.priorities).toContain("tool_preferences");
	});

	test("has evolution feedback signals", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.evolution_focus.feedback_signals).toContain("pr_approved");
		expect(swe.evolution_focus.feedback_signals).toContain("pr_changes_requested");
		expect(swe.evolution_focus.feedback_signals).toContain("ci_pass_first_try");
		expect(swe.evolution_focus.feedback_signals).toContain("thumbs_up_reaction");
	});

	test("has initial config for persona and strategies", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.initial_config.persona).toContain("technical");
		expect(swe.initial_config.task_patterns).toContain("acceptance criteria");
		expect(swe.initial_config.tool_preferences).toContain("grep");
	});

	test("generates a valid system prompt section", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.systemPromptSection).toContain("# Role");
		expect(swe.systemPromptSection).toContain("software engineer");
		expect(swe.systemPromptSection).toContain("# Capabilities");
		expect(swe.systemPromptSection).toContain("# Communication Style");
	});

	test("loads the AEGIS workflow spec into systemPromptSection", () => {
		const swe = loadRoleFromYaml("swe", ROLES_DIR);

		expect(swe.systemPromptSection).toContain("# Workflow");

		// Cardinal git rules
		expect(swe.systemPromptSection).toContain("Never squash");
		expect(swe.systemPromptSection).toContain("Never amend");
		expect(swe.systemPromptSection).toContain("Never force-push");
		expect(swe.systemPromptSection).toContain("--no-ff");

		// Branch model
		expect(swe.systemPromptSection).toContain("main");
		expect(swe.systemPromptSection).toContain("dev");
		expect(swe.systemPromptSection).toContain("hotfix/");

		// Label taxonomy
		expect(swe.systemPromptSection).toContain("auto/feature-small");
		expect(swe.systemPromptSection).toContain("review/risky");
		expect(swe.systemPromptSection).toContain("blocked/needs-human");

		// Hard limits for auto/feature-small
		expect(swe.systemPromptSection).toContain("150");
		expect(swe.systemPromptSection).toContain("Files touched");

		// Sensitive paths
		expect(swe.systemPromptSection).toContain("calibration/");
		expect(swe.systemPromptSection).toContain("safety/");
		expect(swe.systemPromptSection).toContain(".github/");

		// Promotion model
		expect(swe.systemPromptSection).toContain("Promote dev");
		expect(swe.systemPromptSection).toContain("24");

		// Issues workflow
		expect(swe.systemPromptSection).toContain("every PR references an issue");
	});
});

describe("Base Role", () => {
	test("loads the base role from config/roles/base.yaml", () => {
		const base = loadRoleFromYaml("base", ROLES_DIR);

		expect(base.id).toBe("base");
		expect(base.name).toBe("Co-worker");
	});

	test("base role has no MCP tools", () => {
		const base = loadRoleFromYaml("base", ROLES_DIR);
		expect(base.mcp_tools).toEqual([]);
	});

	test("base role has evolution focus", () => {
		const base = loadRoleFromYaml("base", ROLES_DIR);

		expect(base.evolution_focus.priorities.length).toBeGreaterThan(0);
	});

	test("base role has onboarding questions", () => {
		const base = loadRoleFromYaml("base", ROLES_DIR);

		expect(base.onboarding_questions.length).toBeGreaterThan(0);
	});
});

describe("Role System is Generic", () => {
	test("adding a new role requires only YAML (mental check via base role pattern)", () => {
		// The base role has no TypeScript module, only YAML
		// This proves the system works with YAML-only roles
		const base = loadRoleFromYaml("base", ROLES_DIR);
		expect(base.id).toBe("base");
		expect(base.systemPromptSection.length).toBeGreaterThan(0);
	});
});
