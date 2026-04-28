export const AGENT_SDK_MODULE_ENV = "PHANTOM_AGENT_SDK_MODULE";

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

export async function resolveAgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn>(input: {
	defaultRuntime: AgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn>;
	env?: Record<string, string | undefined>;
	importModule?: (specifier: string) => Promise<unknown>;
}): Promise<AgentSdkRuntime<QueryFn, CreateSdkMcpServerFn, ToolFn>> {
	const specifier = input.env?.[AGENT_SDK_MODULE_ENV]?.trim();
	if (!specifier) {
		return input.defaultRuntime;
	}

	const imported = runtimeCandidate(await (input.importModule ?? importRuntimeModule)(specifier));
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
