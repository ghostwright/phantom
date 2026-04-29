import {
	AGENT_RUNTIME_ENV,
	AGENT_RUNTIME_KINDS,
	AGENT_SDK_MODULE_ENV,
	type AgentRuntimeKind,
	DEFAULT_AGENT_RUNTIME_KIND,
	MURPH_AGENT_RUNTIME_MODULE,
	formatAgentRuntimeKinds,
	isAgentRuntimeKind,
} from "./agent-runtime-selection.ts";

export {
	AGENT_RUNTIME_ENV,
	AGENT_RUNTIME_KINDS,
	AGENT_SDK_MODULE_ENV,
	DEFAULT_AGENT_RUNTIME_KIND,
	MURPH_AGENT_RUNTIME_MODULE,
	type AgentRuntimeKind,
	formatAgentRuntimeKinds,
	isAgentRuntimeKind,
};

export type AgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn> = {
	query: QueryFn;
	createSdkMcpServer: CreateSdkMcpServerFn;
	tool: ToolFn;
};

type RuntimeCandidate = Partial<Record<keyof AgentSdkRuntime<unknown, unknown, unknown>, unknown>>;

function runtimeCandidate(value: unknown): RuntimeCandidate {
	if (value && typeof value === "object") {
		return value as RuntimeCandidate;
	}
	return {};
}

async function importRuntimeModule(specifier: string): Promise<unknown> {
	return import(specifier);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requireNamedRuntimeExport(
	candidate: RuntimeCandidate,
	exportName: keyof AgentSdkRuntime<unknown, unknown, unknown>,
	runtime: AgentRuntimeKind,
	specifier: string,
): unknown {
	const value = candidate[exportName];
	if (typeof value !== "function") {
		throw new Error(`Agent runtime "${runtime}" module ${specifier} must export a ${String(exportName)} function.`);
	}
	return value;
}

export async function resolveAgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn>(input: {
	defaultRuntime: AgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn>;
	agentRuntime?: AgentRuntimeKind;
	env?: Record<string, string | undefined>;
	importModule?: (specifier: string) => Promise<unknown>;
}): Promise<AgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn>> {
	const moduleSpecifier = input.env?.[AGENT_SDK_MODULE_ENV]?.trim();
	if (moduleSpecifier) {
		const imported = runtimeCandidate(await (input.importModule ?? importRuntimeModule)(moduleSpecifier));
		if (typeof imported.query !== "function") {
			throw new Error(`${AGENT_SDK_MODULE_ENV} module must export a query function.`);
		}

		return {
			query: imported.query as QueryFn,
			createSdkMcpServer:
				typeof imported.createSdkMcpServer === "function"
					? (imported.createSdkMcpServer as CreateSdkMcpServerFn)
					: input.defaultRuntime.createSdkMcpServer,
			tool: typeof imported.tool === "function" ? (imported.tool as ToolFn) : input.defaultRuntime.tool,
		};
	}

	const runtimeEnvValue = input.env?.[AGENT_RUNTIME_ENV]?.trim();
	let agentRuntime = input.agentRuntime ?? DEFAULT_AGENT_RUNTIME_KIND;
	if (runtimeEnvValue) {
		if (!isAgentRuntimeKind(runtimeEnvValue)) {
			throw new Error(`${AGENT_RUNTIME_ENV} must be one of: ${formatAgentRuntimeKinds()}.`);
		}
		agentRuntime = runtimeEnvValue;
	}
	if (agentRuntime === "anthropic") {
		return input.defaultRuntime;
	}

	let imported: RuntimeCandidate;
	try {
		imported = runtimeCandidate(await (input.importModule ?? importRuntimeModule)(MURPH_AGENT_RUNTIME_MODULE));
	} catch (error) {
		throw new Error(
			`Unable to load agent runtime "murph" from ${MURPH_AGENT_RUNTIME_MODULE}. Install or link ${MURPH_AGENT_RUNTIME_MODULE} into this Phantom project, or use --agent-sdk-module <specifier> for a local compatibility harness. Original error: ${errorMessage(error)}`,
			{ cause: error },
		);
	}

	return {
		query: requireNamedRuntimeExport(imported, "query", agentRuntime, MURPH_AGENT_RUNTIME_MODULE) as QueryFn,
		createSdkMcpServer: requireNamedRuntimeExport(
			imported,
			"createSdkMcpServer",
			agentRuntime,
			MURPH_AGENT_RUNTIME_MODULE,
		) as CreateSdkMcpServerFn,
		tool: requireNamedRuntimeExport(imported, "tool", agentRuntime, MURPH_AGENT_RUNTIME_MODULE) as ToolFn,
	};
}
