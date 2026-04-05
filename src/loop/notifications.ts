import type { SlackBlock } from "../channels/feedback.ts";
import type { SlackChannel } from "../channels/slack.ts";
import { readStateFile } from "./state-file.ts";
import type { LoopStore } from "./store.ts";
import type { Loop, LoopStatus } from "./types.ts";

const PROGRESS_BAR_CELLS = 10;

// Single source of truth for status → emoji. Bare names (no colons) because
// the Slack reactions.add/remove APIs take bare names; the status-message
// text wraps them with colons via `terminalEmoji()`. Keeping both formats
// derived from one map eliminates the silent drift risk when a new terminal
// status is added.
const TERMINAL_REACTION: Partial<Record<LoopStatus, string>> = {
	done: "white_check_mark",
	stopped: "octagonal_sign",
	budget_exceeded: "warning",
	failed: "x",
};

const REACTION_START = "hourglass_flowing_sand";
const REACTION_IN_FLIGHT = "arrows_counterclockwise";

const IN_FLIGHT_REACTIONS = [REACTION_START, REACTION_IN_FLIGHT] as const;

function terminalReaction(status: LoopStatus): string | null {
	return TERMINAL_REACTION[status] ?? null;
}

export function buildProgressBar(done: number, total: number): string {
	if (total <= 0) return `[${"░".repeat(PROGRESS_BAR_CELLS)}]`;
	const clamped = Math.max(0, Math.min(done, total));
	const filled = Math.round((clamped / total) * PROGRESS_BAR_CELLS);
	const empty = PROGRESS_BAR_CELLS - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export function terminalEmoji(status: LoopStatus): string {
	const reaction = TERMINAL_REACTION[status];
	if (reaction) return `:${reaction}:`;
	// Non-terminal statuses still need a glyph for the running-state text.
	return status === "running" ? ":repeat:" : ":grey_question:";
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Status message blocks: one section for the current text plus a Stop button.
 * These must be re-sent on every updateMessage call, because Slack's chat.update
 * replaces the message wholesale and drops any blocks the caller does not
 * include. Passing this on tick updates is how the Stop button survives across
 * progress edits. The final notice deliberately omits blocks so the button
 * disappears on completion.
 */
function buildStatusBlocks(text: string, loopId: string): SlackBlock[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text } },
		{
			type: "actions",
			block_id: `phantom_loop_actions_${loopId}`,
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Stop loop", emoji: true },
					action_id: `phantom:loop_stop:${loopId}`,
					style: "danger",
					value: loopId,
				},
			],
		},
	];
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;
const MAX_SUMMARY_CHARS = 3500;

/**
 * Extract the human-readable body of the state file for the end-of-loop
 * summary. Drops the YAML frontmatter (runner plumbing) and truncates at a
 * safe limit so a runaway state file does not blow out a Slack message.
 * Returns null if the file is unreadable or effectively empty, which signals
 * the caller to skip the summary cleanly.
 */
function extractStateSummary(stateFilePath: string): string | null {
	try {
		const contents = readStateFile(stateFilePath);
		const body = contents.replace(FRONTMATTER_RE, "").trim();
		if (!body) return null;
		if (body.length <= MAX_SUMMARY_CHARS) return body;
		return `${body.slice(0, MAX_SUMMARY_CHARS)}\n\n…(truncated)`;
	} catch {
		return null;
	}
}

/**
 * Slack feedback for the loop lifecycle: start notice, per-tick progress
 * edit, final notice, and a reaction ladder on the operator's original
 * message (hourglass → cycle → terminal emoji).
 *
 * Extracted from LoopRunner because runner.ts was already at the 300-line
 * CONTRIBUTING.md cap and the progress-bar + reaction-ladder additions push
 * it over. All Slack-API failures are swallowed upstream in SlackChannel;
 * if a call-site here still throws, we catch and warn so loop execution is
 * never derailed by chat plumbing.
 *
 * Why not reuse createStatusReactionController: that controller debounces
 * per-tool-call runtime events via a promise-chain serializer. The loop
 * ladder has exactly three sequential lifecycle states (start, first tick,
 * terminal), no debouncing is required, and wiring it into the controller
 * would entangle two unrelated lifecycles. Plain best-effort
 * addReaction/removeReaction is the right choice here.
 */
export class LoopNotifier {
	constructor(
		private slackChannel: SlackChannel | null,
		private store: LoopStore,
	) {}

	async postStartNotice(loop: Loop): Promise<void> {
		if (!this.slackChannel || !loop.channelId) return;
		const text = `:repeat: Starting loop \`${loop.id.slice(0, 8)}\` (max ${loop.maxIterations} iter, $${loop.maxCostUsd.toFixed(2)} budget)\n> ${truncate(loop.goal, 200)}`;
		// When conversationId (a Slack thread ts) is set, thread the updates into it;
		// otherwise post a top-level message in the channel.
		const ts = await this.slackChannel.postToChannel(loop.channelId, text, loop.conversationId ?? undefined);
		if (!ts) return;
		this.store.setStatusMessageTs(loop.id, ts);

		// Attach the stop button so the operator can interrupt without using MCP.
		// Routed via setLoopStopHandler in slack-actions.ts.
		await this.slackChannel.updateMessage(loop.channelId, ts, text, buildStatusBlocks(text, loop.id));

		if (loop.triggerMessageTs) {
			await this.slackChannel.addReaction(loop.channelId, loop.triggerMessageTs, REACTION_START);
		}
	}

	async postTickUpdate(id: string, iteration: number, status: string): Promise<void> {
		const loop = this.store.findById(id);
		if (!loop || !this.slackChannel || !loop.channelId || !loop.statusMessageTs) return;

		const bar = buildProgressBar(iteration, loop.maxIterations);
		const shortId = loop.id.slice(0, 8);
		const text = `:repeat: Loop \`${shortId}\` · ${bar} ${iteration}/${loop.maxIterations} · $${loop.totalCostUsd.toFixed(2)}/$${loop.maxCostUsd.toFixed(2)} · ${status}`;
		// Re-send the blocks on every edit, otherwise Slack strips the Stop
		// button (chat.update replaces the entire message, including blocks).
		await this.slackChannel.updateMessage(loop.channelId, loop.statusMessageTs, text, buildStatusBlocks(text, loop.id));

		// On the first tick, swap hourglass → cycling arrows. Restart-safe by
		// construction: iteration is sourced from the call site, so on resume
		// the swap only fires if the loop is actually transitioning through
		// iteration 1, no in-memory flag to repopulate.
		if (iteration === 1 && loop.triggerMessageTs) {
			await this.slackChannel.removeReaction(loop.channelId, loop.triggerMessageTs, REACTION_START);
			await this.slackChannel.addReaction(loop.channelId, loop.triggerMessageTs, REACTION_IN_FLIGHT);
		}
	}

	async postFinalNotice(loop: Loop, status: LoopStatus): Promise<void> {
		if (!this.slackChannel || !loop.channelId) return;
		const emoji = terminalEmoji(status);
		const bar = buildProgressBar(loop.iterationCount, loop.maxIterations);
		const shortId = loop.id.slice(0, 8);
		const text = `${emoji} Loop \`${shortId}\` · ${bar} ${loop.iterationCount}/${loop.maxIterations} · $${loop.totalCostUsd.toFixed(4)} · ${status}`;
		// Intentionally no blocks on the terminal edit: this strips the Stop
		// button since the loop is no longer interruptible.
		if (loop.statusMessageTs) {
			await this.slackChannel.updateMessage(loop.channelId, loop.statusMessageTs, text);
		} else {
			await this.slackChannel.postToChannel(loop.channelId, text);
		}

		// Post the state.md body as a threaded reply so the operator can see
		// what the agent actually did across the run. The state file is the
		// agent's working memory, curated every tick, so it already contains
		// a progress log the operator wants to read. This costs no extra
		// agent calls; we simply surface content the agent already wrote.
		const summary = extractStateSummary(loop.stateFile);
		if (summary) {
			const summaryThreadTs = loop.conversationId ?? loop.statusMessageTs ?? undefined;
			await this.slackChannel.postToChannel(
				loop.channelId,
				`:notebook: *Loop \`${loop.id.slice(0, 8)}\` final state:*\n\`\`\`\n${summary}\n\`\`\``,
				summaryThreadTs,
			);
		}

		if (loop.triggerMessageTs) {
			// Best-effort: clear whichever in-flight reaction is currently on
			// the message (removeReaction is idempotent on missing), then stamp
			// the terminal one.
			for (const reaction of IN_FLIGHT_REACTIONS) {
				await this.slackChannel.removeReaction(loop.channelId, loop.triggerMessageTs, reaction);
			}
			const terminal = terminalReaction(status);
			if (terminal) {
				await this.slackChannel.addReaction(loop.channelId, loop.triggerMessageTs, terminal);
			}
		}
	}
}
