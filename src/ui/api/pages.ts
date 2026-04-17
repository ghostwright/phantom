// GET /ui/api/pages - list agent-created HTML pages under public/.
//
// Public by design: the landing page renders this list pre-auth and the pages
// themselves are cookie-gated by the static handler below. Exposing the list
// of filenames + titles is information the agent already chose to publish.
//
// Walker rules (matches research 04-avatar-and-landing.md Section 2.3):
//   - Root = getPublicDir(). Recurse up to depth 3.
//   - Include only .html files (case-insensitive extension match).
//   - Exclude boilerplate by exact filename: index.html, _base.html,
//     _components.html, _agent-name.js, phantom-logo.svg, favicon.svg,
//     robots.txt.
//   - Skip these root-level directories wholesale: dashboard, _examples, chat,
//     and anything starting with '.'.
//   - Title: first 8 KiB of the file, regex-extract <title>, decode five basic
//     HTML entities, trim, cap 120 chars. Fallback = filename without .html.
//   - Sort by mtime desc, return top 10.
//   - Returned path is "/ui/<rel>" with forward slashes, never an absolute
//     filesystem path.

import { type Dirent, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { getPublicDir } from "../serve.ts";

const EXCLUDED_FILENAMES = new Set([
	"index.html",
	"_base.html",
	"_components.html",
	"_agent-name.js",
	"phantom-logo.svg",
	"favicon.svg",
	"robots.txt",
]);

const EXCLUDED_ROOT_DIRS = new Set(["dashboard", "_examples", "chat"]);

const TITLE_REGEX = /<title[^>]*>([^<]*)<\/title>/i;
const MAX_TITLE_LEN = 120;
const PAGE_LIMIT = 10;
const HEAD_BYTES = 8192;
const MAX_DEPTH = 3;

export type PageEntry = {
	path: string;
	title: string;
	modified_at: string;
	size: number;
};

type WalkEntry = {
	absolutePath: string;
	relativePath: string;
	mtimeMs: number;
	size: number;
};

function walkPublicHtml(root: string): WalkEntry[] {
	const out: WalkEntry[] = [];

	function recurse(dirAbs: string, depth: number): void {
		if (depth > MAX_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dirAbs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (name.startsWith(".")) continue;

			const childAbs = resolve(dirAbs, name);

			if (entry.isDirectory()) {
				if (depth === 0 && EXCLUDED_ROOT_DIRS.has(name)) continue;
				recurse(childAbs, depth + 1);
				continue;
			}

			if (!entry.isFile()) continue;
			if (!name.toLowerCase().endsWith(".html")) continue;
			if (EXCLUDED_FILENAMES.has(name)) continue;

			const rel = relative(root, childAbs);
			if (rel.startsWith("..") || rel.includes("\0")) continue;
			const posixRel = rel.split(sep).join("/");

			let size = 0;
			let mtimeMs = 0;
			try {
				const stat = statSync(childAbs);
				size = stat.size;
				mtimeMs = stat.mtimeMs;
			} catch {
				continue;
			}
			out.push({ absolutePath: childAbs, relativePath: posixRel, mtimeMs, size });
		}
	}

	recurse(root, 0);
	return out;
}

// Agent-authored <title> tags can include a handful of common HTML entities.
// We decode the safe, printable ones AND numeric refs so the operator sees the
// glyph, not the raw markup. Anything unrecognized passes through unchanged;
// downstream the string is set via textContent so no rendering bypass occurs.
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00A0",
	middot: "\u00B7",
	hellip: "\u2026",
	mdash: "\u2014",
	ndash: "\u2013",
	rsquo: "\u2019",
	lsquo: "\u2018",
	rdquo: "\u201D",
	ldquo: "\u201C",
	copy: "\u00A9",
	reg: "\u00AE",
	trade: "\u2122",
};

function decodeBasicEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref: string) => {
		if (ref.startsWith("#x") || ref.startsWith("#X")) {
			const code = Number.parseInt(ref.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (ref.startsWith("#")) {
			const code = Number.parseInt(ref.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		const replacement = NAMED_ENTITIES[ref];
		return replacement ?? match;
	});
}

function filenameTitle(rel: string): string {
	const base = rel.split("/").pop() ?? rel;
	return base.replace(/\.html$/i, "");
}

async function extractTitle(absolutePath: string, rel: string): Promise<string> {
	try {
		const head = await Bun.file(absolutePath).slice(0, HEAD_BYTES).text();
		const match = TITLE_REGEX.exec(head);
		if (match?.[1]) {
			const decoded = decodeBasicEntities(match[1]).trim();
			if (decoded.length > 0) {
				return decoded.slice(0, MAX_TITLE_LEN);
			}
		}
	} catch {}
	return filenameTitle(rel).slice(0, MAX_TITLE_LEN);
}

export async function handlePagesApi(req: Request): Promise<Response> {
	if (req.method !== "GET") {
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET" },
		});
	}

	const root = getPublicDir();
	let walked: WalkEntry[] = [];
	try {
		walked = walkPublicHtml(root);
	} catch {
		walked = [];
	}

	walked.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const top = walked.slice(0, PAGE_LIMIT);

	const pages: PageEntry[] = await Promise.all(
		top.map(async (entry) => ({
			path: `/ui/${entry.relativePath}`,
			title: await extractTitle(entry.absolutePath, entry.relativePath),
			modified_at: new Date(entry.mtimeMs).toISOString(),
			size: entry.size,
		})),
	);

	return new Response(JSON.stringify({ pages }), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "private, max-age=30",
		},
	});
}
