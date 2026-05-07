import { describe, expect, mock, test } from "bun:test";
import {
	ChannelInteractionRegistry,
	type ChannelInteractionFactory,
	type ChannelInteractionInstance,
} from "../interaction-adapter.ts";
import type { InboundMessage } from "../types.ts";

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		id: "msg-1",
		channelId: "test",
		conversationId: "test:conv-1",
		senderId: "user-1",
		text: "hello",
		timestamp: new Date(),
		...overrides,
	};
}

describe("ChannelInteractionRegistry", () => {
	test("starts empty", () => {
		const registry = new ChannelInteractionRegistry();
		expect(registry.size()).toBe(0);
	});

	test("buildFor returns empty array when no factories registered", () => {
		const registry = new ChannelInteractionRegistry();
		const instances = registry.buildFor(makeMessage());
		expect(instances).toEqual([]);
	});

	test("registers factories and reports size", () => {
		const registry = new ChannelInteractionRegistry();
		registry.register(() => null);
		registry.register(() => null);
		expect(registry.size()).toBe(2);
	});

	test("buildFor calls each factory with the message", () => {
		const registry = new ChannelInteractionRegistry();
		const factoryA = mock((_msg: InboundMessage) => null);
		const factoryB = mock((_msg: InboundMessage) => null);
		registry.register(factoryA);
		registry.register(factoryB);

		const msg = makeMessage({ channelId: "slack" });
		registry.buildFor(msg);

		expect(factoryA).toHaveBeenCalledWith(msg);
		expect(factoryB).toHaveBeenCalledWith(msg);
	});

	test("buildFor returns only non-null instances in registration order", () => {
		const registry = new ChannelInteractionRegistry();
		const instanceA: ChannelInteractionInstance = { dispose: () => {} };
		const instanceC: ChannelInteractionInstance = { dispose: () => {} };

		// A returns instance, B opts out (null), C returns instance
		registry.register(() => instanceA);
		registry.register(() => null);
		registry.register(() => instanceC);

		const instances = registry.buildFor(makeMessage());
		expect(instances).toEqual([instanceA, instanceC]);
	});

	test("factory can decide based on the message channelId", () => {
		const registry = new ChannelInteractionRegistry();
		const slackInstance: ChannelInteractionInstance = { dispose: () => {} };

		const slackFactory: ChannelInteractionFactory = (msg) =>
			msg.channelId === "slack" ? slackInstance : null;
		registry.register(slackFactory);

		const slackMsg = makeMessage({ channelId: "slack" });
		const telegramMsg = makeMessage({ channelId: "telegram" });

		expect(registry.buildFor(slackMsg)).toEqual([slackInstance]);
		expect(registry.buildFor(telegramMsg)).toEqual([]);
	});

	test("clearForTests empties the registry", () => {
		const registry = new ChannelInteractionRegistry();
		registry.register(() => null);
		registry.register(() => null);
		expect(registry.size()).toBe(2);
		registry.clearForTests();
		expect(registry.size()).toBe(0);
	});

	test("instances may have any subset of optional hooks", () => {
		const registry = new ChannelInteractionRegistry();
		// All hooks present
		const fullInstance: ChannelInteractionInstance = {
			onTurnStart: () => {},
			onRuntimeEvent: () => {},
			onTurnEnd: () => {},
			deliverResponse: () => false,
			dispose: () => {},
		};
		// Only one hook
		const minimalInstance: ChannelInteractionInstance = {
			dispose: () => {},
		};
		// Truly empty
		const emptyInstance: ChannelInteractionInstance = {};

		registry.register(() => fullInstance);
		registry.register(() => minimalInstance);
		registry.register(() => emptyInstance);

		const instances = registry.buildFor(makeMessage());
		expect(instances.length).toBe(3);
		expect(instances[0].onTurnStart).toBeDefined();
		expect(instances[1].onTurnStart).toBeUndefined();
		expect(instances[2].dispose).toBeUndefined();
	});
});
