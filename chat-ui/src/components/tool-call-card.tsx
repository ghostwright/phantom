import type { ToolCallState } from "@/lib/chat-types";
import { initialToolDisclosureState, reconcileToolDisclosureState, toggleToolDisclosure } from "@/lib/tool-disclosure";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, ChevronDown, FileText, Loader2, Shield, Terminal, XCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";

const TOOL_ICONS: Record<string, typeof Terminal> = {
	Read: FileText,
	Write: FileText,
	Edit: FileText,
	Bash: Terminal,
	Glob: FileText,
	Grep: FileText,
	WebSearch: FileText,
	WebFetch: FileText,
};

const TOOL_OUTPUT_DISPLAY_LIMIT = 12_000;

function getToolIcon(toolName: string) {
	return TOOL_ICONS[toolName] ?? Terminal;
}

function getToolSubtitle(tool: ToolCallState): string {
	try {
		const input = tool.input ?? JSON.parse(tool.inputJson || "{}");
		const data = input as Record<string, unknown>;

		switch (tool.toolName) {
			case "Read":
				return (data.file_path as string) ?? "";
			case "Write":
				return (data.file_path as string) ?? "";
			case "Edit":
				return (data.file_path as string) ?? "";
			case "Bash":
				return truncate((data.command as string) ?? "", 60);
			case "Glob":
				return (data.pattern as string) ?? "";
			case "Grep":
				return (data.pattern as string) ?? "";
			case "WebSearch":
				return (data.query as string) ?? "";
			case "WebFetch":
				return (data.url as string) ?? "";
			case "Agent":
				return (data.description as string) ?? (data.prompt as string) ?? "";
			default:
				return tool.toolName === "Tool" ? "" : tool.toolName;
		}
	} catch {
		const summary = tool.inputJson.trim();
		if (summary) return truncate(summary.replace(/\s+/g, " "), 80);
		return tool.toolName === "Tool" ? "" : tool.toolName;
	}
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]"],
	[/\b(api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*["']?[^"'\s,}]+/gi, "$1: [REDACTED]"],
	[/([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&\s]+/gi, "$1[REDACTED]"],
];

function redactSensitiveText(value: string): string {
	return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function stringifyInput(input: unknown): string {
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

function toolInputDetails(tool: ToolCallState): { label: string; value: string } | null {
	if (tool.input !== undefined) {
		return { label: "Parameters", value: redactSensitiveText(stringifyInput(tool.input)) };
	}

	const inputJson = tool.inputJson.trim();
	if (!inputJson) return null;

	try {
		return { label: "Parameters", value: redactSensitiveText(JSON.stringify(JSON.parse(inputJson), null, 2)) };
	} catch {
		return { label: "Input", value: redactSensitiveText(inputJson) };
	}
}

function stateLabel(tool: ToolCallState): string {
	if (tool.phase === "started") return tool.state === "running" ? "Running" : "Started";
	if (tool.phase === "partial_output") return "Streaming output";
	if (tool.phase === "completed") return "Completed";
	if (tool.phase === "failed") return "Error";

	switch (tool.state) {
		case "pending":
			return "Queued";
		case "input_streaming":
			return "Preparing";
		case "input_complete":
			return "Ready";
		case "running":
			return "Running";
		case "result":
			return "Completed";
		case "error":
			return "Error";
		case "aborted":
			return "Stopped";
		case "blocked":
			return "Blocked";
	}
}

function durationLabel(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

type StateStyle = {
	border: string;
	icon: typeof Terminal;
	iconClass: string;
	badgeClass: string;
};

function getStateStyle(state: ToolCallState["state"]): StateStyle {
	switch (state) {
		case "pending":
			return {
				border: "border-border/60",
				icon: Terminal,
				iconClass: "animate-pulse text-muted-foreground",
				badgeClass: "border-border bg-muted/55 text-muted-foreground",
			};
		case "input_streaming":
			return {
				border: "border-primary/35 animate-pulse",
				icon: Terminal,
				iconClass: "text-primary",
				badgeClass: "border-primary/25 bg-primary/10 text-primary",
			};
		case "input_complete":
			return {
				border: "border-border/70",
				icon: Terminal,
				iconClass: "text-foreground",
				badgeClass: "border-border bg-muted/45 text-muted-foreground",
			};
		case "running":
			return {
				border: "border-primary/35",
				icon: Loader2,
				iconClass: "text-primary animate-spin",
				badgeClass: "border-primary/25 bg-primary/10 text-primary",
			};
		case "result":
			return {
				border: "border-border/70",
				icon: Check,
				iconClass: "text-success",
				badgeClass: "border-success/20 bg-success/10 text-success",
			};
		case "error":
			return {
				border: "border-error/70",
				icon: XCircle,
				iconClass: "text-error",
				badgeClass: "border-error/25 bg-error/10 text-error",
			};
		case "aborted":
			return {
				border: "border-border/60",
				icon: AlertCircle,
				iconClass: "text-muted-foreground line-through",
				badgeClass: "border-border bg-muted/45 text-muted-foreground",
			};
		case "blocked":
			return {
				border: "border-warning/70",
				icon: Shield,
				iconClass: "text-warning",
				badgeClass: "border-warning/25 bg-warning/10 text-warning",
			};
	}
}

export function ToolCallCard({ tool }: { tool: ToolCallState }) {
	const style = getStateStyle(tool.state);
	const Icon = getToolIcon(tool.toolName);
	const StatusIcon = style.icon;
	const subtitle = getToolSubtitle(tool);
	const bodyId = useId();
	const inputDetails = toolInputDetails(tool);
	const output = tool.output ? redactSensitiveText(truncate(tool.output, TOOL_OUTPUT_DISPLAY_LIMIT)) : "";

	const [disclosure, setDisclosure] = useState(() => initialToolDisclosureState(tool.state));

	useEffect(() => {
		setDisclosure((current) => reconcileToolDisclosureState(current, tool.state));
	}, [tool.state]);

	const isOpen = disclosure.isOpen;
	const hasBody = Boolean(output || tool.error || tool.blockReason || inputDetails || tool.fullRef);
	const detailLabel = isOpen ? "Hide details" : "View details";

	return (
		<div
			className={cn(
				"my-1.5 overflow-hidden rounded-lg border bg-card/80 shadow-sm shadow-black/5 transition-colors",
				style.border,
			)}
		>
			<button
				type="button"
				onClick={() => hasBody && setDisclosure((current) => toggleToolDisclosure(current))}
				className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/35 disabled:hover:bg-transparent"
				disabled={!hasBody}
				aria-expanded={hasBody ? isOpen : undefined}
				aria-controls={hasBody ? bodyId : undefined}
			>
				<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/70">
					<Icon className={cn("h-4 w-4", style.iconClass)} />
				</span>
				<div className="min-w-0 flex-1 text-left">
					<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<span className="font-medium text-foreground">{tool.toolName}</span>
						{subtitle && <span className="min-w-0 max-w-full truncate text-muted-foreground">{subtitle}</span>}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className={cn("rounded border px-1.5 py-0.5 font-medium", style.badgeClass)}>
							{stateLabel(tool)}
						</span>
						{tool.durationMs != null && <span>{durationLabel(tool.durationMs)}</span>}
						{tool.outputTruncated && <span>Output truncated</span>}
						{tool.fullRef && <span>Full output saved</span>}
						{tool.isMcp && <span>{tool.mcpServer ? `MCP: ${tool.mcpServer}` : "MCP"}</span>}
					</div>
				</div>
				<div className="flex items-center gap-1">
					{tool.state === "running" && tool.elapsedSeconds != null && (
						<span className="font-mono text-xs text-muted-foreground">{tool.elapsedSeconds}s</span>
					)}
					{tool.state !== "pending" && tool.state !== "running" && (
						<StatusIcon className={cn("h-3.5 w-3.5", style.iconClass)} />
					)}
					{tool.state === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
					{hasBody && (
						<span className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background/70">
							<span className="hidden sm:inline">{detailLabel}</span>
							<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-180")} />
						</span>
					)}
				</div>
			</button>

			{isOpen && hasBody && (
				<div id={bodyId} className="space-y-3 border-t border-border/70 bg-muted/20 px-3 py-3">
					{inputDetails && (
						<div className="space-y-1">
							<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
								{inputDetails.label}
							</div>
							<pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground">
								{inputDetails.value}
							</pre>
						</div>
					)}
					{tool.error && <p className="text-sm text-error">{redactSensitiveText(tool.error)}</p>}
					{tool.blockReason && <p className="text-sm text-warning">{redactSensitiveText(tool.blockReason)}</p>}
					{tool.fullRef && (
						<div className="space-y-1">
							<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
								Full output path
							</div>
							<div className="rounded-md border border-border/50 bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
								{redactSensitiveText(tool.fullRef)}
							</div>
						</div>
					)}
					{output && (
						<div className="space-y-1">
							<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Output</div>
							<pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground">
								{output}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
