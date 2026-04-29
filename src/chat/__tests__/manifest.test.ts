import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { ChatEventLog } from "../event-log.ts";
import { createChatHandler } from "../http.ts";
import { ChatMessageStore } from "../message-store.ts";
import { ChatSessionStore } from "../session-store.ts";
import { StreamBus } from "../stream-bus.ts";

let db: Database;

function makeRequest(path: string): Request {
	return new Request(`http://localhost:3100${path}`);
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
});

afterEach(() => {
	db.close();
});

describe("GET /chat/manifest.webmanifest", () => {
	test("returns JSON with the configured agent name", async () => {
		const handler = createChatHandler({
			runtime: {} as Parameters<typeof createChatHandler>[0]["runtime"],
			sessionStore: new ChatSessionStore(db),
			messageStore: new ChatMessageStore(db),
			eventLog: new ChatEventLog(db),
			attachmentStore: new ChatAttachmentStore(db),
			streamBus: new StreamBus(),
			getBootstrapData: () => ({ agent_name: "Cheema", evolution_gen: 0 }),
			agentName: "Cheema",
		});
		// Manifest is served without auth so the browser's cookie-less
		// PWA fetch still works. iOS falls back to manifest.name when
		// apple-mobile-web-app-title is absent, so this is the only
		// lever that reaches the home-screen label.
		const res = await handler(makeRequest("/chat/manifest.webmanifest"));
		expect(res?.status).toBe(200);
		expect(res?.headers.get("Content-Type")).toContain("manifest+json");
		const body = (await res?.json()) as {
			name: string;
			short_name: string;
			description: string;
			start_url: string;
			scope: string;
			display: string;
		};
		expect(body.name).toBe("Cheema");
		expect(body.short_name).toBe("Cheema");
		expect(body.description).toContain("Cheema");
		expect(body.start_url).toBe("/chat/");
		expect(body.scope).toBe("/chat/");
		expect(body.display).toBe("standalone");
	});

	test("falls back to Phantom when agent name is not provided", async () => {
		const handler = createChatHandler({
			runtime: {} as Parameters<typeof createChatHandler>[0]["runtime"],
			sessionStore: new ChatSessionStore(db),
			messageStore: new ChatMessageStore(db),
			eventLog: new ChatEventLog(db),
			attachmentStore: new ChatAttachmentStore(db),
			streamBus: new StreamBus(),
			getBootstrapData: () => ({ agent_name: "TestAgent", evolution_gen: 0 }),
		});
		const res = await handler(makeRequest("/chat/manifest.webmanifest"));
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { name: string };
		expect(body.name).toBe("Phantom");
	});
});
