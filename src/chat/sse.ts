import type { ChatWireFrame } from "./types.ts";

export const CHAT_SSE_RETRY_MS = 5000;
export const CHAT_SSE_HEARTBEAT_MS = 5000;
export const CHAT_SSE_HEARTBEAT_FRAME = ":ka\n\n";
export const CHAT_STREAM_ENDED_RECOVERY_MESSAGE =
	"Stream ended before the session completed. Please resend your message.";

export const CHAT_TERMINAL_EVENT_TYPES = ["session.done", "session.error", "session.aborted"] as const;

export const CHAT_SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
	"X-Phantom-Chat-Wire-Version": "1",
} as const;

export type ChatTerminalEventType = (typeof CHAT_TERMINAL_EVENT_TYPES)[number];

export type ChatSseClock<TTimer> = {
	setInterval(callback: () => void, delayMs: number): TTimer;
	clearInterval(timer: TTimer): void;
};

export type ChatSseHeartbeatOptions<TTimer> = {
	clock: ChatSseClock<TTimer>;
	onStop?: () => void;
};

const DEFAULT_CHAT_SSE_CLOCK: ChatSseClock<ReturnType<typeof setInterval>> = {
	setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval> {
		return setInterval(callback, delayMs);
	},
	clearInterval(timer: ReturnType<typeof setInterval>): void {
		clearInterval(timer);
	},
};

export function isTerminalChatEvent(eventType: string): eventType is ChatTerminalEventType {
	return CHAT_TERMINAL_EVENT_TYPES.some((terminalType) => terminalType === eventType);
}

export function createServerRestartRecoveryFrame(sessionId: string): ChatWireFrame {
	return {
		event: "session.error",
		session_id: sessionId,
		message_id: null,
		subtype: "server_restart",
		recoverable: true,
		errors: [CHAT_STREAM_ENDED_RECOVERY_MESSAGE],
		cost_usd: 0,
		duration_ms: 0,
	};
}

export function formatSSE(frame: ChatWireFrame, seq?: number): string {
	const idLine = typeof seq === "number" ? `id: ${seq}\n` : "";
	return `${idLine}event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`;
}

export function closeSseController(controller: ReadableStreamDefaultController<Uint8Array>): void {
	try {
		controller.close();
	} catch {
		/* already closed */
	}
}

export function createSseCloseScheduler(cleanupHeartbeat: () => void, close: () => void): () => void {
	let closeQueued = false;
	return () => {
		if (closeQueued) return;
		closeQueued = true;
		cleanupHeartbeat();
		queueMicrotask(close);
	};
}

export function startSseHeartbeat<TTimer>(
	write: (text: string) => void,
	shouldContinue: () => boolean,
	options: ChatSseHeartbeatOptions<TTimer>,
): () => void;
export function startSseHeartbeat(
	write: (text: string) => void,
	shouldContinue: () => boolean,
	options?: { onStop?: () => void },
): () => void;
export function startSseHeartbeat<TTimer>(
	write: (text: string) => void,
	shouldContinue: () => boolean,
	options?: ChatSseHeartbeatOptions<TTimer> | { onStop?: () => void },
): () => void {
	if (options && "clock" in options) {
		return startHeartbeatWithClock(write, shouldContinue, options.clock, options.onStop);
	}
	return startHeartbeatWithClock(write, shouldContinue, DEFAULT_CHAT_SSE_CLOCK, options?.onStop);
}

function startHeartbeatWithClock<TTimer>(
	write: (text: string) => void,
	shouldContinue: () => boolean,
	clock: ChatSseClock<TTimer>,
	onStop: (() => void) | undefined,
): () => void {
	let closed = false;
	const timer = clock.setInterval(() => {
		if (closed) return;
		if (!shouldContinue()) {
			cleanup();
			onStop?.();
			return;
		}
		write(CHAT_SSE_HEARTBEAT_FRAME);
	}, CHAT_SSE_HEARTBEAT_MS);

	function cleanup(): void {
		if (closed) return;
		closed = true;
		clock.clearInterval(timer);
	}

	return cleanup;
}
