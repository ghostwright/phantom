import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteAttachmentDir,
	deleteAttachmentFile,
	getAttachmentDir,
	getAttachmentPath,
	readAttachmentFile,
	readAttachmentFileBase64,
	readAttachmentFileText,
	resolveStoragePath,
	writeAttachmentFile,
} from "../storage.ts";

let originalCwd: string;
let tmp: string;

beforeEach(() => {
	originalCwd = process.cwd();
	tmp = mkdtempSync(join(tmpdir(), "phantom-chat-storage-"));
	process.chdir(tmp);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmp, { recursive: true, force: true });
});

describe("getAttachmentDir", () => {
	test("returns path under data/chat-attachments/<sessionId>", () => {
		const dir = getAttachmentDir("session-123");
		expect(dir).toContain("data");
		expect(dir).toContain("chat-attachments");
		expect(dir).toContain("session-123");
	});
});

describe("getAttachmentPath", () => {
	test("returns path with fileId and extension", () => {
		const path = getAttachmentPath("session-1", "file-abc", "png");
		expect(path).toContain("session-1");
		expect(path).toEndWith("file-abc.png");
	});
});

describe("resolveStoragePath", () => {
	test("returns the same shape as getAttachmentPath", () => {
		const resolved = resolveStoragePath("s1", "f1", "jpg");
		const direct = getAttachmentPath("s1", "f1", "jpg");
		expect(resolved).toBe(direct);
	});
});

describe("writeAttachmentFile", () => {
	test("writes binary data and returns the file path", async () => {
		const data = Buffer.from("hello world");
		const path = await writeAttachmentFile("sess-1", "file-1", "txt", data);
		expect(path).toContain("file-1.txt");
		expect(existsSync(path)).toBe(true);
	});

	test("creates nested directories automatically", async () => {
		const data = Buffer.from("test");
		const path = await writeAttachmentFile("deep-session", "deep-file", "bin", data);
		expect(existsSync(path)).toBe(true);
	});
});

describe("readAttachmentFile", () => {
	test("reads back the binary content written", async () => {
		const original = Buffer.from([0x00, 0x01, 0x02, 0xff]);
		const path = await writeAttachmentFile("sess-2", "binary-file", "bin", original);
		const read = await readAttachmentFile(path);
		expect(Buffer.compare(read, original)).toBe(0);
	});
});

describe("readAttachmentFileBase64", () => {
	test("returns base64-encoded content", async () => {
		const data = Buffer.from("hello");
		const path = await writeAttachmentFile("sess-3", "b64-file", "txt", data);
		const b64 = await readAttachmentFileBase64(path);
		expect(b64).toBe(Buffer.from("hello").toString("base64"));
	});
});

describe("readAttachmentFileText", () => {
	test("reads text content", async () => {
		const data = Buffer.from("some text content");
		const path = await writeAttachmentFile("sess-4", "text-file", "txt", data);
		const text = await readAttachmentFileText(path);
		expect(text).toBe("some text content");
	});
});

describe("deleteAttachmentFile", () => {
	test("deletes an existing file", async () => {
		const data = Buffer.from("delete me");
		const path = await writeAttachmentFile("sess-5", "doomed", "txt", data);
		expect(existsSync(path)).toBe(true);
		await deleteAttachmentFile(path);
		expect(existsSync(path)).toBe(false);
	});

	test("does not throw when file does not exist", async () => {
		await expect(deleteAttachmentFile("/nonexistent/path/to/file.txt")).resolves.toBeUndefined();
	});
});

describe("deleteAttachmentDir", () => {
	test("removes the entire session directory", async () => {
		const data = Buffer.from("content");
		await writeAttachmentFile("sess-del", "file1", "txt", data);
		await writeAttachmentFile("sess-del", "file2", "txt", data);
		const dir = getAttachmentDir("sess-del");
		expect(existsSync(dir)).toBe(true);
		await deleteAttachmentDir("sess-del");
		expect(existsSync(dir)).toBe(false);
	});

	test("does not throw when directory does not exist", async () => {
		await expect(deleteAttachmentDir("nonexistent-session")).resolves.toBeUndefined();
	});
});
