import {
	CHAT_POST_TERMINAL_GRACE_MS,
	CHAT_SSE_RETRY_MS,
	closeSseController,
	createSseCloseScheduler,
	formatSSE,
	isTerminalChatEvent,
	startSseHeartbeat,
} from "./sse.ts";
import type { StreamBus } from "./stream-bus.ts";
import type { ChatSessionWriter } from "./writer.ts";

export function createSSEStream(sessionId: string, streamBus: StreamBus, writer: ChatSessionWriter): ReadableStream {
	let unsub: (() => void) | null = null;
	let heartbeatCleanup: (() => void) | null = null;
	let postTerminalTimer: ReturnType<typeof setTimeout> | null = null;
	let waitingForPostTerminal = false;
	const cleanupStream = (): void => {
		unsub?.();
		unsub = null;
		heartbeatCleanup?.();
		heartbeatCleanup = null;
		if (postTerminalTimer) {
			clearTimeout(postTerminalTimer);
			postTerminalTimer = null;
		}
	};

	return new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const write = (text: string): void => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					/* closed */
				}
			};

			const close = (): void => {
				cleanupStream();
				closeSseController(controller);
			};
			const closeSoon = createSseCloseScheduler(() => {
				heartbeatCleanup?.();
				heartbeatCleanup = null;
			}, close);
			const finishPostTerminal = (): void => {
				waitingForPostTerminal = false;
				if (postTerminalTimer) {
					clearTimeout(postTerminalTimer);
					postTerminalTimer = null;
				}
				closeSoon();
			};

			write(`retry: ${CHAT_SSE_RETRY_MS}\n\n`);

			unsub = streamBus.subscribe(sessionId, (frame, seq) => {
				write(formatSSE(frame, seq));
				if (isTerminalChatEvent(frame.event)) {
					waitingForPostTerminal = true;
					if (postTerminalTimer) clearTimeout(postTerminalTimer);
					postTerminalTimer = setTimeout(finishPostTerminal, CHAT_POST_TERMINAL_GRACE_MS);
				}
				if (frame.event === "session.title_updated") {
					finishPostTerminal();
				}
			});

			heartbeatCleanup = startSseHeartbeat(write, () => writer.isActive || waitingForPostTerminal, {
				onStop: closeSoon,
			});
		},
		cancel() {
			cleanupStream();
		},
	});
}
