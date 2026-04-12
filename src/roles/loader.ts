import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { RoleConfigSchema, type RoleModule, type RoleTemplate } from "./types.ts";

const ROLES_CONFIG_DIR = resolve("config/roles");

export function loadRoleFromYaml(roleId: string, configDir?: string): RoleTemplate {
	const dir = configDir ?? ROLES_CONFIG_DIR;
	const yamlPath = join(dir, `${roleId}.yaml`);

	if (!existsSync(yamlPath)) {
		throw new Error(`Role config not found: ${yamlPath}. Available roles can be listed with the role registry.`);
	}

	let text: string;
	try {
		text = readFileSync(yamlPath, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read role config at ${yamlPath}: ${msg}`);
	}

	const parsed: unknown = parse(text);
	const result = RoleConfigSchema.safeParse(parsed);

	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid role config for '${roleId}':\n${issues}`);
	}

	const config = result.data;
	return {
		...config,
		systemPromptSection: buildSystemPromptSection(config),
	};
}

export function loadRoleModule(roleId: string): RoleModule | null {
	// Role modules are loaded dynamically from src/roles/{roleId}.ts
	// This is a synchronous check - actual module loading happens at registration time
	const modulePath = resolve(`src/roles/${roleId}.ts`);
	if (!existsSync(modulePath)) {
		return null;
	}
	// The actual import is done by the registry since it's async
	return null;
}

export function listAvailableRoles(configDir?: string): string[] {
	const dir = configDir ?? ROLES_CONFIG_DIR;
	if (!existsSync(dir)) return [];

	const { readdirSync } = require("node:fs") as typeof import("node:fs");
	return readdirSync(dir)
		.filter((f: string) => f.endsWith(".yaml"))
		.map((f: string) => f.replace(".yaml", ""));
}

function buildSystemPromptSection(config: {
	identity: string;
	capabilities: string[];
	communication: string;
	workflow_spec: string;
}): string {
	const parts: string[] = [];

	parts.push(`# Role\n\n${config.identity}`);

	if (config.capabilities.length > 0) {
		const capList = config.capabilities.map((c) => `- ${c}`).join("\n");
		parts.push(`# Capabilities\n\n${capList}`);
	}

	parts.push(`# Communication Style\n\n${config.communication}`);

	if (config.workflow_spec.trim()) {
		parts.push(`# Workflow\n\n${config.workflow_spec.trim()}`);
	}

	return parts.join("\n\n");
}
