import type { ChatWireFrame } from "./types.ts";

type FrameCallback = (frame: ChatWireFrame, seq: number) => void;

export class StreamBus {
	private subscribers = new Map<string, Set<FrameCallback>>();

	subscribe(sessionId: string, callback: FrameCallback): () => void {
		let set = this.subscribers.get(sessionId);
		if (!set) {
			set = new Set();
			this.subscribers.set(sessionId, set);
		}
		set.add(callback);

		return () => {
			set.delete(callback);
			if (set.size === 0) {
				this.subscribers.delete(sessionId);
			}
		};
	}

	publish(sessionId: string, frame: ChatWireFrame, seq: number): void {
		const set = this.subscribers.get(sessionId);
		if (!set) return;
		for (const cb of set) {
			try {
				cb(frame, seq);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[stream-bus] Subscriber error for session ${sessionId}: ${msg}`);
			}
		}
	}

	hasSubscribers(sessionId: string): boolean {
		const set = this.subscribers.get(sessionId);
		return set !== undefined && set.size > 0;
	}

	subscriberCount(sessionId: string): number {
		return this.subscribers.get(sessionId)?.size ?? 0;
	}
}
