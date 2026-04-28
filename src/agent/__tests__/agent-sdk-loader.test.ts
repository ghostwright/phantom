import { describe, expect, test } from "bun:test";
import { AGENT_SDK_MODULE_ENV, resolveAgentSdkRuntime } from "../agent-sdk-loader.ts";

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
});
