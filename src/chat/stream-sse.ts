import {
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
	const cleanupStream = (): void => {
		unsub?.();
		unsub = null;
		heartbeatCleanup?.();
		heartbeatCleanup = null;
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

			write(`retry: ${CHAT_SSE_RETRY_MS}\n\n`);

			unsub = streamBus.subscribe(sessionId, (frame, seq) => {
				write(formatSSE(frame, seq));
				if (isTerminalChatEvent(frame.event)) {
					closeSoon();
				}
			});

			heartbeatCleanup = startSseHeartbeat(write, () => writer.isActive, { onStop: closeSoon });
		},
		cancel() {
			cleanupStream();
		},
	});
}
