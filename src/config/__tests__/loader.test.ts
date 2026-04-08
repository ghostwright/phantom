import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../loader.ts";

const TEST_DIR = "/tmp/phantom-test-config";

function writeYaml(filename: string, content: string): string {
	mkdirSync(TEST_DIR, { recursive: true });
	const path = `${TEST_DIR}/${filename}`;
	writeFileSync(path, content);
	return path;
}

function cleanup(): void {
	rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("loadConfig", () => {
	test("loads a valid config file", () => {
		const path = writeYaml(
			"valid.yaml",
			`
name: test-phantom
port: 3200
role: swe
model: claude-opus-4-6
effort: high
max_budget_usd: 25
`,
		);
		try {
			const config = loadConfig(path);
			expect(config.name).toBe("test-phantom");
			expect(config.port).toBe(3200);
			expect(config.role).toBe("swe");
			expect(config.model).toBe("claude-opus-4-6");
			expect(config.effort).toBe("high");
			expect(config.max_budget_usd).toBe(25);
		} finally {
			cleanup();
		}
	});

	test("applies defaults for optional fields", () => {
		const path = writeYaml(
			"minimal.yaml",
			`
name: minimal
`,
		);
		try {
			const config = loadConfig(path);
			expect(config.name).toBe("minimal");
			expect(config.port).toBe(3100);
			expect(config.role).toBe("swe");
			expect(config.effort).toBe("max");
			expect(config.max_budget_usd).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("throws on missing file", () => {
		expect(() => loadConfig("/tmp/phantom-nonexistent.yaml")).toThrow("Config file not found");
	});

	test("throws on invalid config", () => {
		const path = writeYaml(
			"invalid.yaml",
			`
port: -1
`,
		);
		try {
			expect(() => loadConfig(path)).toThrow("Invalid config");
		} finally {
			cleanup();
		}
	});

	test("throws on invalid effort value", () => {
		const path = writeYaml(
			"bad-effort.yaml",
			`
name: test
effort: turbo
`,
		);
		try {
			expect(() => loadConfig(path)).toThrow("Invalid config");
		} finally {
			cleanup();
		}
	});

	test("env var overrides YAML model", () => {
		const path = writeYaml(
			"env-model.yaml",
			`
name: test-phantom
model: claude-opus-4-6
`,
		);
		const saved = process.env.PHANTOM_MODEL;
		try {
			process.env.PHANTOM_MODEL = "claude-sonnet-4-6";
			const config = loadConfig(path);
			expect(config.model).toBe("claude-sonnet-4-6");
			expect(config.model_source).toBe("env");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_MODEL = saved;
			} else {
				process.env.PHANTOM_MODEL = undefined;
			}
			cleanup();
		}
	});

	test("model_source defaults to config when no env override", () => {
		const path = writeYaml(
			"model-source-default.yaml",
			`
name: test-phantom
model: claude-opus-4-6
`,
		);
		const saved = process.env.PHANTOM_MODEL;
		try {
			process.env.PHANTOM_MODEL = undefined;
			const config = loadConfig(path);
			expect(config.model_source).toBe("config");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_MODEL = saved;
			}
			cleanup();
		}
	});

	test("env var overrides YAML domain", () => {
		const path = writeYaml(
			"env-domain.yaml",
			`
name: test-phantom
domain: old.example.com
`,
		);
		const saved = process.env.PHANTOM_DOMAIN;
		try {
			process.env.PHANTOM_DOMAIN = "new.ghostwright.dev";
			const config = loadConfig(path);
			expect(config.domain).toBe("new.ghostwright.dev");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_DOMAIN = saved;
			} else {
				process.env.PHANTOM_DOMAIN = undefined;
			}
			cleanup();
		}
	});

	test("PHANTOM_NAME env var overrides YAML name", () => {
		const path = writeYaml(
			"env-name.yaml",
			`
name: phantom-dev
`,
		);
		const saved = process.env.PHANTOM_NAME;
		try {
			process.env.PHANTOM_NAME = "cheema";
			const config = loadConfig(path);
			expect(config.name).toBe("cheema");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_NAME = saved;
			} else {
				process.env.PHANTOM_NAME = undefined;
			}
			cleanup();
		}
	});

	test("PHANTOM_NAME env var is trimmed", () => {
		const path = writeYaml(
			"env-name-trim.yaml",
			`
name: phantom-dev
`,
		);
		const saved = process.env.PHANTOM_NAME;
		try {
			process.env.PHANTOM_NAME = "  cheema  ";
			const config = loadConfig(path);
			expect(config.name).toBe("cheema");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_NAME = saved;
			} else {
				process.env.PHANTOM_NAME = undefined;
			}
			cleanup();
		}
	});

	test("empty PHANTOM_NAME env var does not override YAML", () => {
		const path = writeYaml(
			"env-name-empty.yaml",
			`
name: phantom-dev
`,
		);
		const saved = process.env.PHANTOM_NAME;
		try {
			process.env.PHANTOM_NAME = "";
			const config = loadConfig(path);
			expect(config.name).toBe("phantom-dev");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_NAME = saved;
			} else {
				process.env.PHANTOM_NAME = undefined;
			}
			cleanup();
		}
	});

	test("PHANTOM_ROLE env var overrides YAML role", () => {
		const path = writeYaml(
			"env-role.yaml",
			`
name: test
role: swe
`,
		);
		const saved = process.env.PHANTOM_ROLE;
		try {
			process.env.PHANTOM_ROLE = "base";
			const config = loadConfig(path);
			expect(config.role).toBe("base");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_ROLE = saved;
			} else {
				process.env.PHANTOM_ROLE = undefined;
			}
			cleanup();
		}
	});

	test("PHANTOM_EFFORT env var overrides YAML effort with valid value", () => {
		const path = writeYaml(
			"env-effort.yaml",
			`
name: test
effort: max
`,
		);
		const saved = process.env.PHANTOM_EFFORT;
		try {
			process.env.PHANTOM_EFFORT = "low";
			const config = loadConfig(path);
			expect(config.effort).toBe("low");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_EFFORT = saved;
			} else {
				process.env.PHANTOM_EFFORT = undefined;
			}
			cleanup();
		}
	});

	test("PHANTOM_EFFORT env var with invalid value falls back to YAML", () => {
		const path = writeYaml(
			"env-effort-invalid.yaml",
			`
name: test
effort: high
`,
		);
		const saved = process.env.PHANTOM_EFFORT;
		try {
			process.env.PHANTOM_EFFORT = "turbo";
			const config = loadConfig(path);
			expect(config.effort).toBe("high");
		} finally {
			if (saved !== undefined) {
				process.env.PHANTOM_EFFORT = saved;
			} else {
				process.env.PHANTOM_EFFORT = undefined;
			}
			cleanup();
		}
	});

	test("PORT env var overrides YAML port", () => {
		const path = writeYaml(
			"env-port.yaml",
			`
name: test
port: 3100
`,
		);
		const saved = process.env.PORT;
		try {
			process.env.PORT = "8080";
			const config = loadConfig(path);
			expect(config.port).toBe(8080);
		} finally {
			if (saved !== undefined) {
				process.env.PORT = saved;
			} else {
				process.env.PORT = undefined;
			}
			cleanup();
		}
	});

	test("PORT env var with non-numeric value falls back to YAML", () => {
		const path = writeYaml(
			"env-port-nan.yaml",
			`
name: test
port: 3100
`,
		);
		const saved = process.env.PORT;
		try {
			process.env.PORT = "abc";
			const config = loadConfig(path);
			expect(config.port).toBe(3100);
		} finally {
			if (saved !== undefined) {
				process.env.PORT = saved;
			} else {
				process.env.PORT = undefined;
			}
			cleanup();
		}
	});

	test("PORT env var with out-of-range value falls back to YAML", () => {
		const path = writeYaml(
			"env-port-range.yaml",
			`
name: test
port: 3100
`,
		);
		const saved = process.env.PORT;
		try {
			process.env.PORT = "70000";
			const config = loadConfig(path);
			expect(config.port).toBe(3100);
		} finally {
			if (saved !== undefined) {
				process.env.PORT = saved;
			} else {
				process.env.PORT = undefined;
			}
			cleanup();
		}
	});
});
