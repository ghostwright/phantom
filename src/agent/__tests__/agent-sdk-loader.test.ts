import { describe, expect, test } from "bun:test";
import {
	AGENT_RUNTIME_ENV,
	AGENT_SDK_MODULE_ENV,
	MURPH_AGENT_RUNTIME_MODULE,
	resolveAgentSdkRuntime,
} from "../agent-sdk-loader.ts";

function defaultRuntime() {
	return {
		query: () => "default-query",
		createSdkMcpServer: () => "default-server",
		tool: () => "default-tool",
	};
}

describe("Agent SDK runtime loader", () => {
	test("uses the bundled runtime when no override is configured", async () => {
		const runtime = defaultRuntime();

		await expect(resolveAgentSdkRuntime({ defaultRuntime: runtime, env: {} })).resolves.toBe(runtime);
	});

	test("loads the Murph runtime module when selected by name", async () => {
		const runtime = await resolveAgentSdkRuntime({
			defaultRuntime: defaultRuntime(),
			agentRuntime: "murph",
			env: {},
			importModule: async (specifier) => {
				expect(specifier).toBe(MURPH_AGENT_RUNTIME_MODULE);
				return {
					query: () => "murph-query",
					createSdkMcpServer: () => "murph-server",
					tool: () => "murph-tool",
				};
			},
		});

		expect(runtime.query()).toBe("murph-query");
		expect(runtime.createSdkMcpServer()).toBe("murph-server");
		expect(runtime.tool()).toBe("murph-tool");
	});

	test("PHANTOM_AGENT_RUNTIME overrides the input runtime", async () => {
		const runtime = await resolveAgentSdkRuntime({
			defaultRuntime: defaultRuntime(),
			agentRuntime: "anthropic",
			env: { [AGENT_RUNTIME_ENV]: "murph" },
			importModule: async () => ({
				query: () => "murph-query",
				createSdkMcpServer: () => "murph-server",
				tool: () => "murph-tool",
			}),
		});

		expect(runtime.query()).toBe("murph-query");
	});

	test("loads a compatible runtime module from PHANTOM_AGENT_SDK_MODULE", async () => {
		const runtime = await resolveAgentSdkRuntime({
			defaultRuntime: defaultRuntime(),
			env: { [AGENT_SDK_MODULE_ENV]: "file:///tmp/fake-sdk.js" },
			importModule: async (specifier) => {
				expect(specifier).toBe("file:///tmp/fake-sdk.js");
				return {
					query: () => "custom-query",
					createSdkMcpServer: () => "custom-server",
					tool: () => "custom-tool",
				};
			},
		});

		expect(runtime.query()).toBe("custom-query");
		expect(runtime.createSdkMcpServer()).toBe("custom-server");
		expect(runtime.tool()).toBe("custom-tool");
	});

	test("PHANTOM_AGENT_SDK_MODULE wins over PHANTOM_AGENT_RUNTIME", async () => {
		const runtime = await resolveAgentSdkRuntime({
			defaultRuntime: defaultRuntime(),
			env: {
				[AGENT_SDK_MODULE_ENV]: "file:///tmp/custom-sdk.js",
				[AGENT_RUNTIME_ENV]: "murph",
			},
			importModule: async (specifier) => {
				expect(specifier).toBe("file:///tmp/custom-sdk.js");
				return { query: () => "custom-query" };
			},
		});

		expect(runtime.query()).toBe("custom-query");
	});

	test("falls back to bundled helpers when an override only supplies query", async () => {
		const bundled = defaultRuntime();
		const runtime = await resolveAgentSdkRuntime({
			defaultRuntime: bundled,
			env: { [AGENT_SDK_MODULE_ENV]: "custom-sdk" },
			importModule: async () => ({ query: () => "custom-query" }),
		});

		expect(runtime.query()).toBe("custom-query");
		expect(runtime.createSdkMcpServer).toBe(bundled.createSdkMcpServer);
		expect(runtime.tool).toBe(bundled.tool);
	});

	test("rejects override modules without a query export", async () => {
		await expect(
			resolveAgentSdkRuntime({
				defaultRuntime: defaultRuntime(),
				env: { [AGENT_SDK_MODULE_ENV]: "broken-sdk" },
				importModule: async () => ({ tool: () => "custom-tool" }),
			}),
		).rejects.toThrow(`${AGENT_SDK_MODULE_ENV} module must export a query function.`);
	});

	test("rejects invalid runtime values with valid values listed", async () => {
		await expect(
			resolveAgentSdkRuntime({
				defaultRuntime: defaultRuntime(),
				env: { [AGENT_RUNTIME_ENV]: "murp" },
			}),
		).rejects.toThrow(`${AGENT_RUNTIME_ENV} must be one of: anthropic, murph.`);
	});

	test("wraps missing Murph package errors with an actionable message", async () => {
		await expect(
			resolveAgentSdkRuntime({
				defaultRuntime: defaultRuntime(),
				agentRuntime: "murph",
				env: {},
				importModule: async () => {
					throw new Error("Cannot find package");
				},
			}),
		).rejects.toThrow(
			`Unable to load agent runtime "murph" from ${MURPH_AGENT_RUNTIME_MODULE}. Install or link ${MURPH_AGENT_RUNTIME_MODULE}`,
		);
	});

	test("rejects Murph modules that omit helper exports", async () => {
		await expect(
			resolveAgentSdkRuntime({
				defaultRuntime: defaultRuntime(),
				agentRuntime: "murph",
				env: {},
				importModule: async () => ({
					query: () => "murph-query",
					createSdkMcpServer: () => "murph-server",
				}),
			}),
		).rejects.toThrow(`Agent runtime "murph" module ${MURPH_AGENT_RUNTIME_MODULE} must export a tool function.`);
	});
});
