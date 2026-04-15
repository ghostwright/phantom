// Server-side focus tracking for notification gating.
// The client sends POST /chat/focus heartbeats every 10 seconds while a
// session tab is visible. The server uses this to suppress notifications
// for sessions the user is actively watching.

type FocusEntry = {
	tabId: string;
	lastHeartbeat: number;
};

const FOCUS_STALE_MS = 30_000; // 30 seconds without heartbeat = unfocused

export class SessionFocusMap {
	private entries = new Map<string, FocusEntry>();

	isFocused(sessionId: string): boolean {
		const entry = this.entries.get(sessionId);
		if (!entry) return false;
		if (Date.now() - entry.lastHeartbeat > FOCUS_STALE_MS) {
			this.entries.delete(sessionId);
			return false;
		}
		return true;
	}

	updateFocus(sessionId: string, tabId: string, focused: boolean): void {
		if (focused) {
			this.entries.set(sessionId, {
				tabId,
				lastHeartbeat: Date.now(),
			});
		} else {
			this.entries.delete(sessionId);
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
