export const AGENT_SDK_MODULE_ENV = "PHANTOM_AGENT_SDK_MODULE";
export const AGENT_RUNTIME_ENV = "PHANTOM_AGENT_RUNTIME";

export const AGENT_RUNTIME_KINDS = ["anthropic", "murph"] as const;
export type AgentRuntimeKind = (typeof AGENT_RUNTIME_KINDS)[number];

export const DEFAULT_AGENT_RUNTIME_KIND: AgentRuntimeKind = "anthropic";
export const MURPH_AGENT_RUNTIME_MODULE = "@murph/anthropic-sdk-shim";

export function isAgentRuntimeKind(value: string): value is AgentRuntimeKind {
	return (AGENT_RUNTIME_KINDS as readonly string[]).includes(value);
}

export function formatAgentRuntimeKinds(): string {
	return AGENT_RUNTIME_KINDS.join(", ");
}
