import { describe, expect, test } from "bun:test";
import { AGENT_SDK_MODULE_ENV } from "../../agent/agent-sdk-loader.ts";
import { applyStartEnv, parseStartArgs } from "../start.ts";

describe("phantom start", () => {
	test("parses Agent SDK module override", () => {
		expect(parseStartArgs(["--agent-sdk-module", "file:///tmp/murph-shim.js"])).toEqual({
			help: false,
			daemon: false,
			agentSdkModule: "file:///tmp/murph-shim.js",
		});
	});

	test("parses port, config, daemon, and help flags", () => {
		expect(parseStartArgs(["--port", "3101", "--config", "config/local.yaml", "--daemon", "--help"])).toEqual({
			help: true,
			daemon: true,
			port: "3101",
			config: "config/local.yaml",
		});
	});

	test("applies runtime overrides to the child environment", () => {
		const env: Record<string, string | undefined> = {};
		applyStartEnv(
			{
				help: false,
				daemon: false,
				port: "3102",
				config: "config/local.yaml",
				agentSdkModule: "file:///tmp/murph-shim.js",
			},
			env,
		);

		expect(env.PORT).toBe("3102");
		expect(env.PHANTOM_PORT_OVERRIDE).toBe("3102");
		expect(env.PHANTOM_CONFIG_PATH).toBe("config/local.yaml");
		expect(env[AGENT_SDK_MODULE_ENV]).toBe("file:///tmp/murph-shim.js");
	});
});
