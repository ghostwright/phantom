import type { RunActivityState, SubagentActivity, ToolCallState } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
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

function activityFacts(activity: RunActivityState): string[] {
	const facts: string[] = [];
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
	return facts.filter((fact) => fact.length > 0).slice(0, 3);
}

export function RunActivityRow({
	activity,
	toolCalls,
}: {
	activity: RunActivityState;
	toolCalls: ToolCallState[];
}) {
	const { Icon, className } = statusIcon(activity);
	const facts = activityFacts(activity);

	return (
		<div className="flex justify-start">
			<div className="max-w-[85%] min-w-0 space-y-2 py-1">
				<div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
					<Icon className={cn("mt-0.5 h-4 w-4 shrink-0", className)} />
					<div className="min-w-0 flex-1">
						<div className="truncate text-foreground">{activity.currentLabel}</div>
						{facts.length > 0 && (
							<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
								{facts.map((fact) => (
									<span key={fact} className="max-w-full truncate">
										{fact}
									</span>
								))}
							</div>
						)}
					</div>
				</div>

				{toolCalls.map((tool) => (
					<ToolCallCard key={tool.id} tool={tool} />
				))}
			</div>
		</div>
	);
}
