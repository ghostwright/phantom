import { describe, expect, test } from "bun:test";
import { createSSEResponse, getListenerCount, publish, subscribe } from "../events.ts";

describe("subscribe/publish", () => {
	test("listener receives published events", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = subscribe((event, data) => {
			received.push({ event, data });
		});

		publish("test", { value: 42 });
		expect(received).toHaveLength(1);
		expect(received[0].event).toBe("test");
		expect(received[0].data).toEqual({ value: 42 });

		unsub();
	});

	test("unsubscribe removes listener", () => {
		const received: string[] = [];
		const unsub = subscribe((event) => {
			received.push(event);
		});

		publish("before", {});
		unsub();
		publish("after", {});

		expect(received).toEqual(["before"]);
	});

	test("multiple listeners all receive events", () => {
		let count = 0;
		const unsub1 = subscribe(() => {
			count++;
		});
		const unsub2 = subscribe(() => {
			count++;
		});

		publish("test", {});
		expect(count).toBe(2);

		unsub1();
		unsub2();
	});

	test("error in one listener does not affect others", () => {
		let reached = false;
		const unsub1 = subscribe(() => {
			throw new Error("boom");
		});
		const unsub2 = subscribe(() => {
			reached = true;
		});

		publish("test", {});
		expect(reached).toBe(true);

		unsub1();
		unsub2();
	});

	test("getListenerCount tracks active listeners", () => {
		// events.ts uses a module-level listener set that can be touched by
		// other tests in the same bun test process. Measure relative to the
		// initial count so this test is robust to ordering.
		const initial = getListenerCount();
		const unsub1 = subscribe(() => {});
		expect(getListenerCount()).toBe(initial + 1);
		const unsub2 = subscribe(() => {});
		expect(getListenerCount()).toBe(initial + 2);
		unsub1();
		expect(getListenerCount()).toBe(initial + 1);
		unsub2();
		expect(getListenerCount()).toBe(initial);
	});
});

describe("createSSEResponse", () => {
	test("returns a Response with correct headers", () => {
		const response = createSSEResponse();
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
	});

	test("response body is a ReadableStream", () => {
		const response = createSSEResponse();
		expect(response.body).not.toBeNull();
		expect(response.body).toBeInstanceOf(ReadableStream);
	});
});
