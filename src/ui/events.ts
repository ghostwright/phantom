// Dashboard SSE bus. Listeners can be synchronous or async; publish wraps
// every call in a try/catch AND attaches a rejection handler to any
// returned promise so a future async subscriber cannot leak an unhandled
// rejection to the process. Future subscribers (metrics counter,
// per-session rollup, rate limiter) will be tempted to use async/await
// and this guard keeps that safe.

type EventListener = (event: string, data: unknown) => void | Promise<void>;

const listeners = new Set<EventListener>();

export function subscribe(listener: EventListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function publish(event: string, data: unknown): void {
	for (const listener of listeners) {
		try {
			const result = listener(event, data);
			if (result && typeof (result as Promise<void>).then === "function") {
				(result as Promise<void>).catch((err) => {
					console.warn(`[events] async listener error on ${event}:`, err);
				});
			}
		} catch (err) {
			console.warn(`[events] sync listener error on ${event}:`, err);
		}
	}
}

export function createSSEResponse(): Response {
	let unsubscribe: (() => void) | null = null;
	let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			// Suggest a 5 second reconnect window so browsers come back
			// fast after a proxy drop. Cloudflare and Caddy strip most
			// buffering when X-Accel-Buffering: no is on the response,
			// but the retry hint makes disconnects self-healing.
			controller.enqueue(encoder.encode("retry: 5000\n"));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

			unsubscribe = subscribe((event, data) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					// Stream may be closed; the cancel hook unsubscribes.
				}
			});

			// Periodic keep-alive comment line (lines starting with `:`
			// are ignored by the EventSource parser) so intermediaries
			// like Cloudflare/Caddy do not buffer the connection dead.
			// The interval lives with the stream: cancel() clears it.
			keepAliveInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(":keep-alive\n\n"));
				} catch {
					// Stream closed; the cancel hook clears the interval.
				}
			}, 25_000);
		},
		cancel() {
			unsubscribe?.();
			if (keepAliveInterval) {
				clearInterval(keepAliveInterval);
				keepAliveInterval = null;
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			// Disable upstream proxy buffering (nginx and Caddy both
			// honor this header). Without it, an SSE stream can be
			// buffered for minutes before reaching the browser.
			"X-Accel-Buffering": "no",
		},
	});
}

export function getListenerCount(): number {
	return listeners.size;
}
