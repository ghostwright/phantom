import { describe, expect, test } from "bun:test";
import {
	CHAT_SSE_HEADERS,
	CHAT_SSE_HEARTBEAT_FRAME,
	CHAT_SSE_HEARTBEAT_MS,
	type ChatSseClock,
	createServerRestartRecoveryFrame,
	isTerminalChatEvent,
	startSseHeartbeat,
} from "../sse.ts";

type FakeTimer = {
	callback: () => void;
	delayMs: number;
	active: boolean;
};

class FakeClock implements ChatSseClock<FakeTimer> {
	readonly timers: FakeTimer[] = [];
	clearCalls = 0;

	setInterval(callback: () => void, delayMs: number): FakeTimer {
		const timer: FakeTimer = { callback, delayMs, active: true };
		this.timers.push(timer);
		return timer;
	}

	clearInterval(timer: FakeTimer): void {
		this.clearCalls++;
		timer.active = false;
	}

	tick(index = 0): void {
		const timer = this.timers[index];
		if (timer?.active) {
			timer.callback();
		}
	}
}

describe("chat SSE helpers", () => {
	test("heartbeat writes keepalive, stops on shouldContinue false, and cleanup is idempotent", () => {
		const clock = new FakeClock();
		const writes: string[] = [];
		let active = true;

		const cleanup = startSseHeartbeat(
			(text) => {
				writes.push(text);
			},
			() => active,
			{ clock },
		);

		expect(clock.timers).toHaveLength(1);
		expect(clock.timers[0]?.delayMs).toBe(CHAT_SSE_HEARTBEAT_MS);

		clock.tick();
		expect(writes).toEqual([CHAT_SSE_HEARTBEAT_FRAME]);

		active = false;
		clock.tick();
		expect(writes).toEqual([CHAT_SSE_HEARTBEAT_FRAME]);
		expect(clock.clearCalls).toBe(1);

		clock.tick();
		cleanup();
		cleanup();
		expect(writes).toEqual([CHAT_SSE_HEARTBEAT_FRAME]);
		expect(clock.clearCalls).toBe(1);
	});

	test("heartbeat onStop fires once when the writer becomes inactive", () => {
		const clock = new FakeClock();
		let active = true;
		let stopCalls = 0;

		const cleanup = startSseHeartbeat(
			() => {},
			() => active,
			{
				clock,
				onStop: () => {
					stopCalls++;
				},
			},
		);

		active = false;
		clock.tick();
		clock.tick();
		cleanup();

		expect(stopCalls).toBe(1);
		expect(clock.clearCalls).toBe(1);
	});

	test("shared headers disable transform buffering", () => {
		expect(CHAT_SSE_HEADERS["Cache-Control"]).toContain("no-transform");
		expect(CHAT_SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
	});

	test("terminal helper includes done, error, and aborted", () => {
		expect(isTerminalChatEvent("session.done")).toBe(true);
		expect(isTerminalChatEvent("session.error")).toBe(true);
		expect(isTerminalChatEvent("session.aborted")).toBe(true);
		expect(isTerminalChatEvent("message.text_delta")).toBe(false);
	});

	test("server restart recovery frame is non-message terminal output", () => {
		const frame = createServerRestartRecoveryFrame("sess-1");
		expect(frame.event).toBe("session.error");
		if (frame.event !== "session.error") {
			throw new Error("Expected session.error frame");
		}
		expect(frame.message_id).toBeNull();
		expect(frame.subtype).toBe("server_restart");
		expect(frame.recoverable).toBe(true);
		expect(frame.cost_usd).toBe(0);
		expect(frame.duration_ms).toBe(0);
	});
});
