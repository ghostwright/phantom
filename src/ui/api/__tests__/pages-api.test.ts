// Tests for GET /ui/api/pages.
//
// Each test points setPublicDir at a tmp directory so boilerplate exclusions,
// title extraction, and mtime sort exercise real disk IO without touching the
// repo's own public/ tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleUiRequest, setPublicDir } from "../../serve.ts";

const realPublic = resolve(import.meta.dir, "../../../../public");

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "phantom-pages-api-"));
	setPublicDir(tmpDir);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	setPublicDir(realPublic);
});

function writePage(rel: string, content: string, mtimeSeconds?: number): string {
	const full = join(tmpDir, rel);
	mkdirSync(full.substring(0, full.lastIndexOf("/")), { recursive: true });
	writeFileSync(full, content, "utf-8");
	if (mtimeSeconds !== undefined) {
		utimesSync(full, mtimeSeconds, mtimeSeconds);
	}
	return full;
}

function req(): Request {
	return new Request("http://localhost/ui/api/pages", { method: "GET" });
}

type PagesResponse = {
	pages: Array<{ path: string; title: string; modified_at: string; size: number }>;
};

describe("GET /ui/api/pages", () => {
	test("empty public dir returns pages: []", async () => {
		const res = await handleUiRequest(req());
		expect(res.status).toBe(200);
		const body = (await res.json()) as PagesResponse;
		expect(body.pages).toEqual([]);
	});

	test("cache-control header present", async () => {
		const res = await handleUiRequest(req());
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=30");
	});

	test("returns a single agent-created page with extracted title", async () => {
		writePage("hacker-news.html", "<!DOCTYPE html><html><head><title>HN Digest</title></head></html>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.length).toBe(1);
		expect(body.pages[0].path).toBe("/ui/hacker-news.html");
		expect(body.pages[0].title).toBe("HN Digest");
		expect(body.pages[0].size).toBeGreaterThan(0);
	});

	test("decodes HTML entities in titles and trims whitespace", async () => {
		writePage("metrics.html", "<html><head><title>   Weekly &amp; monthly   </title></head></html>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages[0].title).toBe("Weekly & monthly");
	});

	test("falls back to filename when <title> is missing or empty", async () => {
		writePage("no-title.html", "<html><head></head><body>hi</body></html>");
		writePage("empty.html", "<html><head><title>   </title></head></html>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		const titles = new Map(body.pages.map((p) => [p.path, p.title]));
		expect(titles.get("/ui/no-title.html")).toBe("no-title");
		expect(titles.get("/ui/empty.html")).toBe("empty");
	});

	test("excludes boilerplate filenames", async () => {
		for (const name of [
			"index.html",
			"_base.html",
			"_components.html",
			"_agent-name.js",
			"phantom-logo.svg",
			"favicon.svg",
			"robots.txt",
		]) {
			writePage(name, "boiler");
		}
		writePage("report.html", "<html><head><title>Report</title></head></html>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.length).toBe(1);
		expect(body.pages[0].path).toBe("/ui/report.html");
	});

	test("excludes dashboard, _examples, chat directories wholesale", async () => {
		writePage("dashboard/index.html", "<title>Dashboard</title>");
		writePage("dashboard/cost.html", "<title>Cost</title>");
		writePage("_examples/01-landing.html", "<title>Example</title>");
		writePage("chat/index.html", "<title>Chat</title>");
		writePage("keep.html", "<html><head><title>Keep</title></head></html>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.length).toBe(1);
		expect(body.pages[0].path).toBe("/ui/keep.html");
	});

	test("walks up to depth 3", async () => {
		writePage("a/b/c/deep.html", "<html><head><title>Deep</title></head></html>");
		writePage("a/b/c/d/too-deep.html", "<html><head><title>Too Deep</title></head></html>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		const paths = body.pages.map((p) => p.path);
		expect(paths).toContain("/ui/a/b/c/deep.html");
		expect(paths).not.toContain("/ui/a/b/c/d/too-deep.html");
	});

	test("sorts by mtime desc", async () => {
		const now = Date.now() / 1000;
		writePage("old.html", "<title>Old</title>", now - 3600);
		writePage("newest.html", "<title>Newest</title>", now);
		writePage("middle.html", "<title>Middle</title>", now - 1800);
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.map((p) => p.path)).toEqual(["/ui/newest.html", "/ui/middle.html", "/ui/old.html"]);
	});

	test("caps at 10 entries", async () => {
		const now = Date.now() / 1000;
		for (let i = 0; i < 12; i++) {
			writePage(`page-${i}.html`, `<title>Page ${i}</title>`, now - i);
		}
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.length).toBe(10);
	});

	test("POST returns 405", async () => {
		const res = await handleUiRequest(new Request("http://localhost/ui/api/pages", { method: "POST" }));
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});

	test("skips non-html extensions", async () => {
		writePage("note.txt", "hello");
		writePage("data.json", "{}");
		writePage("real.html", "<title>Real</title>");
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.length).toBe(1);
		expect(body.pages[0].path).toBe("/ui/real.html");
	});

	test("endpoint is public (no cookie required)", async () => {
		writePage("public-page.html", "<title>Public</title>");
		const res = await handleUiRequest(req());
		expect(res.status).toBe(200);
		const body = (await res.json()) as PagesResponse;
		expect(body.pages.length).toBe(1);
	});

	test("caps title at 120 chars", async () => {
		const longTitle = "t".repeat(300);
		writePage("long.html", `<title>${longTitle}</title>`);
		const res = await handleUiRequest(req());
		const body = (await res.json()) as PagesResponse;
		expect(body.pages[0].title.length).toBe(120);
	});
});
