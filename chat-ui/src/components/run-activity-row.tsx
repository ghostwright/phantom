import { extractToolArtifacts, mergeArtifactViews } from "@/lib/chat-artifacts";
import type { ChatArtifactView, RunActivityState, SubagentActivity, ToolCallState } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, CheckCircle2, Clock3, Loader2, Radio, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ArtifactTray } from "./artifact-tray";
import { ToolCallCard } from "./tool-call-card";

function statusIcon(activity: RunActivityState): {
	Icon: LucideIcon;
	className: string;
} {
	switch (activity.status) {
		case "completed":
			return { Icon: CheckCircle2, className: "text-success" };
		case "error":
			return { Icon: AlertCircle, className: "text-error" };
		case "aborted":
		case "rate_limited":
			return { Icon: ShieldAlert, className: "text-warning" };
		case "starting":
		case "working":
		case "compacting":
			return {
				Icon: activity.isActive ? Loader2 : Activity,
				className: activity.isActive ? "animate-spin text-primary" : "text-muted-foreground",
			};
	}
}

function latestSubagent(activity: RunActivityState): SubagentActivity | null {
	let latest: SubagentActivity | null = null;
	for (const subagent of activity.subagents.values()) {
		if (!latest || subagent.updatedAt > latest.updatedAt) latest = subagent;
	}
	return latest;
}

function useLiveNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!active) {
			setNow(Date.now());
			return;
		}
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active]);

	return now;
}

function formatElapsed(ms: number): string {
	const safeMs = Math.max(0, ms);
	const totalSeconds = Math.floor(safeMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

function statusText(activity: RunActivityState): string {
	switch (activity.status) {
		case "starting":
			return "Starting";
		case "working":
			return activity.isActive ? "Live" : "Working";
		case "compacting":
			return "Compacting";
		case "rate_limited":
			return "Limited";
		case "completed":
			return "Done";
		case "error":
			return "Needs attention";
		case "aborted":
			return "Stopped";
	}
}

function statusTone(activity: RunActivityState): string {
	switch (activity.status) {
		case "completed":
			return "border-success/25 bg-success/10 text-success";
		case "error":
			return "border-error/25 bg-error/10 text-error";
		case "aborted":
		case "rate_limited":
			return "border-warning/25 bg-warning/10 text-warning";
		case "compacting":
		case "starting":
		case "working":
			return activity.isActive
				? "border-primary/25 bg-primary/10 text-primary"
				: "border-border bg-muted text-muted-foreground";
	}
}

function plural(count: number, singular: string): string {
	return `${count.toLocaleString()} ${singular}${count === 1 ? "" : "s"}`;
}

function toolFacts(toolCalls: ToolCallState[]): string[] {
	const running = toolCalls.filter((tool) => tool.state === "running");
	const completed = toolCalls.filter((tool) => tool.state === "result");
	const issues = toolCalls.filter(
		(tool) => tool.state === "error" || tool.state === "blocked" || tool.state === "aborted",
	);
	const facts: string[] = [];
	if (running.length > 0) {
		facts.push(`Using ${running.map((tool) => tool.toolName).join(", ")}`);
	}
	if (completed.length > 0) {
		facts.push(`${plural(completed.length, "tool")} completed`);
	}
	if (issues.length > 0) {
		facts.push(issues.length === 1 ? "1 tool needs attention" : `${plural(issues.length, "tool")} need attention`);
	}
	if (facts.length === 0 && toolCalls.length > 0) {
		facts.push(plural(toolCalls.length, "tool"));
	}
	return facts;
}

function activityFacts(activity: RunActivityState, toolCalls: ToolCallState[]): string[] {
	const facts: string[] = [];
	facts.push(...toolFacts(toolCalls));
	if (activity.compact) {
		facts.push(`Compacted ${activity.compact.preTokens.toLocaleString()} tokens`);
	}
	if (activity.rateLimit?.utilization != null) {
		facts.push(`Rate limit ${Math.round(activity.rateLimit.utilization * 100)}%`);
	}
	if (activity.mcpServers && activity.mcpServers.length > 0) {
		const ready = activity.mcpServers.filter((server) => server.status === "connected").length;
		facts.push(`${ready}/${activity.mcpServers.length} tool servers ready`);
	}
	const subagent = latestSubagent(activity);
	if (subagent) {
		facts.push(subagent.summary ?? subagent.description);
	}
	return facts.filter((fact) => fact.length > 0).slice(0, 5);
}

function sortedSubagents(activity: RunActivityState): SubagentActivity[] {
	return [...activity.subagents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
}

function subagentMeta(subagent: SubagentActivity): string {
	const parts: string[] = [];
	if (subagent.lastToolName) parts.push(subagent.lastToolName);
	if (subagent.toolUses != null) parts.push(plural(subagent.toolUses, "tool use"));
	if (subagent.totalTokens != null) parts.push(`${subagent.totalTokens.toLocaleString()} tokens`);
	if (subagent.durationMs != null) parts.push(formatElapsed(subagent.durationMs));
	return parts.join(" / ");
}

export function RunActivityRow({
	activity,
	toolCalls,
	artifacts: durableArtifacts = [],
}: {
	activity: RunActivityState;
	toolCalls: ToolCallState[];
	artifacts?: ChatArtifactView[];
}) {
	const { Icon, className } = statusIcon(activity);
	const now = useLiveNow(activity.isActive);
	const elapsedAt = activity.isActive ? now : Date.parse(activity.updatedAt);
	const elapsed = formatElapsed(elapsedAt - Date.parse(activity.startedAt));
	const facts = useMemo(() => activityFacts(activity, toolCalls), [activity, toolCalls]);
	const subagents = useMemo(() => sortedSubagents(activity), [activity]);
	const artifacts = useMemo(
		() => mergeArtifactViews(durableArtifacts, extractToolArtifacts(toolCalls)),
		[durableArtifacts, toolCalls],
	);

	return (
		<div className="flex justify-start">
			<section className="max-w-[92%] min-w-0 py-1.5" aria-label="Run activity">
				<div className="relative pl-5">
					<div className="absolute bottom-2 left-[7px] top-3 w-px bg-border" />
					<div className="relative flex min-w-0 items-start gap-3">
						<div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-background">
							<Icon className={cn("h-4 w-4", className)} />
						</div>
						<div className="min-w-0 flex-1 space-y-2">
							<div className="min-w-0">
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<span className="min-w-0 truncate text-sm font-medium text-foreground">{activity.currentLabel}</span>
									<span
										className={cn(
											"inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] font-medium",
											statusTone(activity),
										)}
									>
										{activity.isActive && activity.status !== "completed" ? <Radio className="h-3 w-3" /> : null}
										{statusText(activity)}
									</span>
									<span className="inline-flex h-5 shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
										<Clock3 className="h-3 w-3" />
										{elapsed}
									</span>
								</div>
								{facts.length > 0 && (
									<div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
										{facts.map((fact) => (
											<span
												key={fact}
												className="max-w-full truncate rounded border border-border bg-muted/45 px-2 py-0.5"
											>
												{fact}
											</span>
										))}
									</div>
								)}
							</div>

							{subagents.length > 0 && (
								<div className="space-y-1 border-l border-border pl-3">
									{subagents.map((subagent) => (
										<div key={subagent.taskId} className="min-w-0 text-xs">
											<div className="flex min-w-0 items-center gap-2">
												<span
													className={cn(
														"h-1.5 w-1.5 shrink-0 rounded-full",
														subagent.status === "running"
															? "bg-primary"
															: subagent.status === "completed"
																? "bg-success"
																: "bg-warning",
													)}
												/>
												<span className="min-w-0 truncate text-foreground">
													{subagent.summary ?? subagent.description}
												</span>
											</div>
											{subagentMeta(subagent) && (
												<div className="ml-3.5 truncate text-muted-foreground">{subagentMeta(subagent)}</div>
											)}
										</div>
									))}
								</div>
							)}

							<ArtifactTray artifacts={artifacts} />
						</div>
					</div>

					{toolCalls.length > 0 && (
						<div className="mt-2 space-y-2">
							{toolCalls.map((tool) => (
								<ToolCallCard key={tool.id} tool={tool} />
							))}
						</div>
					)}
				</div>
			</section>
		</div>
	);
}
