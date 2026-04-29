import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { buildUserMessageParam } from "../message-builder.ts";

let db: Database;
let attachmentStore: ChatAttachmentStore;
const tmpDir = join(process.cwd(), "data", "chat-attachments", "test-session-mb");

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	attachmentStore = new ChatAttachmentStore(db);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	db.close();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// cleanup best effort
	}
});

describe("buildUserMessageParam", () => {
	test("text-only message returns plain string content", async () => {
		const msg = await buildUserMessageParam("hello world", [], attachmentStore);
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("hello world");
	});

	test("text + image attachment produces ImageBlockParam", async () => {
		const imgPath = join(tmpDir, "test.png");
		writeFileSync(imgPath, Buffer.from("fake-png-data"));

		attachmentStore.create({
			sessionId: "test-session-mb",
			kind: "image",
			filename: "test.png",
			mimeType: "image/png",
			sizeBytes: 13,
			storagePath: imgPath,
		});
		const rows = attachmentStore.getBySession("test-session-mb");
		const attId = rows[0]?.id ?? "";

		const msg = await buildUserMessageParam("describe this", [attId], attachmentStore);
		expect(msg.role).toBe("user");
		expect(Array.isArray(msg.content)).toBe(true);

		const content = msg.content as unknown as Array<Record<string, unknown>>;
		expect(content.length).toBe(2);

		const imageBlock = content[0];
		expect(imageBlock?.type).toBe("image");
		const source = imageBlock?.source as Record<string, unknown>;
		expect(source?.type).toBe("base64");
		expect(source?.media_type).toBe("image/png");
		expect(typeof source?.data).toBe("string");

		const textBlock = content[1];
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toBe("describe this");
	});

	test("text + PDF attachment produces DocumentBlockParam with base64", async () => {
		const pdfPath = join(tmpDir, "doc.pdf");
		writeFileSync(pdfPath, Buffer.from("fake-pdf-data"));

		attachmentStore.create({
			sessionId: "test-session-mb",
			kind: "pdf",
			filename: "spec.pdf",
			mimeType: "application/pdf",
			sizeBytes: 13,
			storagePath: pdfPath,
		});
		const rows = attachmentStore.getBySession("test-session-mb");
		const attId = rows[0]?.id ?? "";

		const msg = await buildUserMessageParam("summarize", [attId], attachmentStore);
		const content = msg.content as unknown as Array<Record<string, unknown>>;
		expect(content.length).toBe(2);

		const docBlock = content[0];
		expect(docBlock?.type).toBe("document");
		const source = docBlock?.source as Record<string, unknown>;
		expect(source?.type).toBe("base64");
		expect(source?.media_type).toBe("application/pdf");
		expect(docBlock?.title).toBe("spec.pdf");
	});

	test("text + code file produces DocumentBlockParam with text source", async () => {
		const codePath = join(tmpDir, "utils.ts");
		writeFileSync(codePath, "export function add(a: number, b: number) { return a + b; }");

		attachmentStore.create({
			sessionId: "test-session-mb",
			kind: "text",
			filename: "utils.ts",
			mimeType: "text/plain",
			sizeBytes: 55,
			storagePath: codePath,
		});
		const rows = attachmentStore.getBySession("test-session-mb");
		const attId = rows[0]?.id ?? "";

		const msg = await buildUserMessageParam("review this", [attId], attachmentStore);
		const content = msg.content as unknown as Array<Record<string, unknown>>;
		expect(content.length).toBe(2);

		const docBlock = content[0];
		expect(docBlock?.type).toBe("document");
		const source = docBlock?.source as Record<string, unknown>;
		expect(source?.type).toBe("text");
		expect(source?.media_type).toBe("text/plain");
		expect(typeof source?.data).toBe("string");
		expect(source?.data).toContain("export function add");
		expect(docBlock?.title).toBe("utils.ts");
	});

	test("multiple attachments maintain correct order (images first, text last)", async () => {
		const imgPath = join(tmpDir, "photo.jpg");
		writeFileSync(imgPath, Buffer.from("jpg-data"));
		const pdfPath = join(tmpDir, "doc.pdf");
		writeFileSync(pdfPath, Buffer.from("pdf-data"));
		const codePath = join(tmpDir, "app.js");
		writeFileSync(codePath, "console.log('hi');");

		attachmentStore.create({
			sessionId: "test-session-mb",
			kind: "text",
			filename: "app.js",
			mimeType: "text/javascript",
			sizeBytes: 18,
			storagePath: codePath,
		});
		attachmentStore.create({
			sessionId: "test-session-mb",
			kind: "image",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			sizeBytes: 8,
			storagePath: imgPath,
		});
		attachmentStore.create({
			sessionId: "test-session-mb",
			kind: "pdf",
			filename: "doc.pdf",
			mimeType: "application/pdf",
			sizeBytes: 8,
			storagePath: pdfPath,
		});

		const rows = attachmentStore.getBySession("test-session-mb");
		const ids = rows.map((r) => r.id);

		const msg = await buildUserMessageParam("analyze all", ids, attachmentStore);
		const content = msg.content as unknown as Array<Record<string, unknown>>;

		// Order: image, pdf, text file, user text
		expect(content.length).toBe(4);
		expect(content[0]?.type).toBe("image");
		expect(content[1]?.type).toBe("document");
		expect((content[1]?.source as Record<string, unknown>)?.type).toBe("base64");
		expect(content[2]?.type).toBe("document");
		expect((content[2]?.source as Record<string, unknown>)?.type).toBe("text");
		expect(content[3]?.type).toBe("text");
		expect(content[3]?.text).toBe("analyze all");
	});

	test("ignores non-existent attachment ids", async () => {
		const msg = await buildUserMessageParam("hello", ["nonexistent-id"], attachmentStore);
		expect(msg.content).toBe("hello");
	});
});
