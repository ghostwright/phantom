/**
 * Channel-agnostic interaction adapter.
 *
 * Each channel that wants progress signaling, status reactions, typing
 * indicators, or response-delivery customization (Slack progress streams,
 * Nextcloud reactions, Telegram typing, etc.) registers a factory here.
 * The orchestration in `src/index.ts` walks the registry once per inbound
 * message and asks each factory whether it applies to that message.
 *
 * Phase 1 of the Telegram parity plan: extract the per-channel `if (isSlack)`
 * / `if (isNextcloud)` / `if (isTelegram)` ladder in `src/index.ts` into
 * adapter objects that share a uniform lifecycle. No behavior change in this
 * step — the Slack and Nextcloud adapters are direct lifts of the existing
 * code, and existing channel tests must continue to pass unchanged.
 *
 * Cardinal Rule: the agent decides what to say; channels render. This
 * abstraction is pure rendering — every adapter method is best-effort and
 * must never throw into the orchestration loop.
 */

import type { InboundMessage } from "./types.ts";
import type { StatusReactionController } from "./status-reactions.ts";
import type { ProgressStream } from "./progress-stream.ts";
import type { RuntimeEvent } from "../agent/runtime.ts";

/**
 * Per-message adapter instance. Created once per inbound message by the
 * factory; lives for the duration of one runtime turn.
 *
 * All methods are optional and best-effort. The orchestration calls each
 * non-null hook in a fixed order:
 *
 *   1. `statusReactions.setQueued()` (if present) — fired immediately.
 *   2. `progressStream.start()` (if present) — awaited before runtime.
 *   3. `onTurnStart()` (if present) — awaited before runtime.
 *   4. `onRuntimeEvent(event)` for each event from runtime.handleMessage.
 *   5. `onTurnEnd({ text, isError })` — awaited after runtime.
 *   6. `deliverResponse({ text, isError })` (if present) — awaited last.
 *      An adapter that returns `true` from `deliverResponse` claims the
 *      response; the orchestration will NOT fall back to router.send().
 *   7. `dispose()` (if present) — fired in the cleanup block, always.
 *
 * Any adapter method may return undefined/void; promises are awaited.
 */
export type ChannelInteractionInstance = {
	/** Status reaction controller for this turn, if the channel supports reactions. */
	readonly statusReactions?: StatusReactionController;

	/** Progress stream for this turn, if the channel supports progressive updates. */
	readonly progressStream?: ProgressStream;

	/** Called once before runtime.handleMessage. Best-effort. */
	onTurnStart?: () => Promise<void> | void;

	/** Called for each RuntimeEvent emitted by runtime.handleMessage. Best-effort. */
	onRuntimeEvent?: (event: RuntimeEvent) => void;

	/**
	 * Called once after runtime.handleMessage returns (or throws).
	 * `isError` reflects the combined error signal (event flag + text sniff).
	 * Best-effort.
	 */
	onTurnEnd?: (result: { text: string; isError: boolean }) => Promise<void> | void;

	/**
	 * Optional channel-specific response delivery. Return `true` to claim
	 * the response (orchestration will skip the default router.send fallback).
	 * Return `false` or undefined to fall through to router.send.
	 *
	 * Slack uses this to attach feedback buttons via progressStream.finish.
	 * Most channels don't implement this and let the router deliver.
	 */
	deliverResponse?: (result: { text: string; isError: boolean }) => Promise<boolean> | boolean;

	/** Cleanup hook, always called from the orchestration's cleanup block. */
	dispose?: () => void;
};

/**
 * Factory: given an inbound message, decide whether to participate in this
 * turn and return an instance. Return null to opt out.
 */
export type ChannelInteractionFactory = (msg: InboundMessage) => ChannelInteractionInstance | null;

/**
 * Registry of channel interaction factories. Iterated in registration order
 * for each inbound message. The first factory whose `deliverResponse` returns
 * true claims the response; other factories' `deliverResponse` hooks still
 * fire (they may want to do non-delivery cleanup), but the router fallback
 * is skipped.
 */
export class ChannelInteractionRegistry {
	private factories: ChannelInteractionFactory[] = [];

	register(factory: ChannelInteractionFactory): void {
		this.factories.push(factory);
	}

	/**
	 * Build adapter instances for the given inbound message. Returns only
	 * the non-null instances, in registration order.
	 */
	buildFor(msg: InboundMessage): ChannelInteractionInstance[] {
		const instances: ChannelInteractionInstance[] = [];
		for (const factory of this.factories) {
			const instance = factory(msg);
			if (instance) instances.push(instance);
		}
		return instances;
	}

	/** Test seam: number of registered factories. */
	size(): number {
		return this.factories.length;
	}

	/** Test seam: clear all factories. Production code never calls this. */
	clearForTests(): void {
		this.factories = [];
	}
}
