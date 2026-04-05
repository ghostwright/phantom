import { describe, expect, test } from "bun:test";
import { type SlackContext, slackContextStore } from "../slack-context.ts";

const SAMPLE: SlackContext = {
	slackChannelId: "C123",
	slackThreadTs: "1700000000.000100",
	slackMessageTs: "1700000000.000200",
};

describe("slackContextStore", () => {
	test("getStore() is undefined outside a run()", () => {
		expect(slackContextStore.getStore()).toBeUndefined();
	});

	test("synchronous read inside run() sees the context", () => {
		const seen = slackContextStore.run(SAMPLE, () => slackContextStore.getStore());
		expect(seen).toEqual(SAMPLE);
	});

	test("context propagates across a plain await boundary", async () => {
		const seen = await slackContextStore.run(SAMPLE, async () => {
			await Promise.resolve();
			return slackContextStore.getStore();
		});
		expect(seen).toEqual(SAMPLE);
	});

	test("context propagates across a setImmediate hop", async () => {
		const seen = await slackContextStore.run(SAMPLE, async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			return slackContextStore.getStore();
		});
		expect(seen).toEqual(SAMPLE);
	});

	test("context propagates through an async generator for-await loop", async () => {
		async function* producer(): AsyncGenerator<number> {
			for (let i = 0; i < 3; i++) {
				await Promise.resolve();
				yield i;
			}
		}

		const observations: (SlackContext | undefined)[] = [];
		await slackContextStore.run(SAMPLE, async () => {
			for await (const _ of producer()) {
				observations.push(slackContextStore.getStore());
			}
		});

		expect(observations.length).toBe(3);
		for (const seen of observations) {
			expect(seen).toEqual(SAMPLE);
		}
	});

	test("concurrent run() calls keep contexts isolated", async () => {
		const other: SlackContext = {
			slackChannelId: "C999",
			slackThreadTs: "2700000000.000100",
			slackMessageTs: "2700000000.000200",
		};

		const [a, b] = await Promise.all([
			slackContextStore.run(SAMPLE, async () => {
				await Promise.resolve();
				return slackContextStore.getStore();
			}),
			slackContextStore.run(other, async () => {
				await Promise.resolve();
				return slackContextStore.getStore();
			}),
		]);

		expect(a).toEqual(SAMPLE);
		expect(b).toEqual(other);
	});
});
