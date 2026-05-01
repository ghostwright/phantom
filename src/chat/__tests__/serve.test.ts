import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPublicDir } from "../../ui/serve.ts";
import { handleChatStaticRequest } from "../serve.ts";

let publicDir: string;

beforeEach(async () => {
	publicDir = await mkdtemp(join(tmpdir(), "phantom-chat-static-"));
	await mkdir(join(publicDir, "chat"), { recursive: true });
	await writeFile(join(publicDir, "chat", "index.html"), '<div id="root">chat app</div>');
	await writeFile(join(publicDir, "chat", "asset.txt"), "asset bytes");
	setPublicDir(publicDir);
});

afterEach(async () => {
	await rm(publicDir, { recursive: true, force: true });
});

function req(path: string): Request {
	return new Request(`http://localhost:3100${path}`, { headers: { Accept: "text/html" } });
}

describe("handleChatStaticRequest", () => {
	test("serves concrete /chat assets from public/chat", async () => {
		const res = await handleChatStaticRequest(req("/chat/asset.txt"));
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("asset bytes");
	});

	test("falls back to the chat SPA for /chat session routes", async () => {
		const res = await handleChatStaticRequest(req("/chat/s/session-123"));
		expect(res?.status).toBe(200);
		expect(await res?.text()).toContain("chat app");
	});

	test("falls back to the chat SPA for legacy /s session routes", async () => {
		const res = await handleChatStaticRequest(req("/s/session-123"));
		expect(res?.status).toBe(200);
		expect(await res?.text()).toContain("chat app");
	});

	test("ignores non-chat paths", async () => {
		const res = await handleChatStaticRequest(req("/ui/"));
		expect(res).toBeNull();
	});
});
