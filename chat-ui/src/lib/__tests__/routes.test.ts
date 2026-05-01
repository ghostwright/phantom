import { describe, expect, it } from "vitest";
import { CHAT_ROOT_PATH, chatSessionPath, legacyChatSessionPath } from "../routes";

describe("chat routes", () => {
	it("uses the deployed chat root as the canonical browser path", () => {
		expect(CHAT_ROOT_PATH).toBe("/chat");
		expect(chatSessionPath("session-123")).toBe("/chat/s/session-123");
	});

	it("keeps the legacy session path available for old links", () => {
		expect(legacyChatSessionPath("session-123")).toBe("/s/session-123");
	});

	it("encodes session ids before placing them in the URL", () => {
		expect(chatSessionPath("session/with space")).toBe("/chat/s/session%2Fwith%20space");
		expect(legacyChatSessionPath("session/with space")).toBe("/s/session%2Fwith%20space");
	});
});
