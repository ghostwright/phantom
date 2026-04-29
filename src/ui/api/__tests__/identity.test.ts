// Tests for POST/DELETE /ui/api/identity/avatar and GET /ui/avatar.
//
// We point the handler at a tmp dir via setIdentityDirForTests so each case
// exercises real disk I/O (atomic rename, extension swap, ETag parity) with
// no cross-test bleed.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { handleUiRequest, setDashboardDb, setPublicDir } from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";
import { avatarUrlIfPresent, readAvatarMetaForManifest, setIdentityDirForTests } from "../identity.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

function runMigrations(target: Database): void {
	for (const migration of MIGRATIONS) {
		try {
			target.run(migration);
		} catch {
			/* idempotent */
		}
	}
}

// Bytes shaped to pass the handler's magic-byte sniff. The handler does not
// decode, so valid headers + filler are all that's required.
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

function withHeader(header: number[], length = 128): Uint8Array {
	const out = new Uint8Array(Math.max(length, header.length));
	for (let i = 0; i < header.length; i++) out[i] = header[i];
	for (let i = header.length; i < out.length; i++) out[i] = (i * 7) & 0xff;
	return out;
}
const pngBytes = (length = 128) => withHeader(PNG_HEADER, length);
const jpegBytes = (length = 128) => withHeader(JPEG_HEADER, length);
const webpBytes = (length = 128) => withHeader(WEBP_HEADER, length);
const svgBytes = () =>
	new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let db: Database;
let sessionToken: string;
let tmpDir: string;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	setDashboardDb(db);
	sessionToken = createSession().sessionToken;
	tmpDir = mkdtempSync(join(tmpdir(), "phantom-identity-test-"));
	setIdentityDirForTests(tmpDir);
});

afterEach(() => {
	setIdentityDirForTests(null);
	db.close();
	revokeAllSessions();
	rmSync(tmpDir, { recursive: true, force: true });
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Cookie: `phantom_session=${encodeURIComponent(sessionToken)}`, ...extra };
}
function publicHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { ...extra };
}

async function postAvatar(
	mime: string,
	bytes: Uint8Array,
	filename = "logo.bin",
	opts: { cookie?: boolean; contentLength?: number | null } = {},
): Promise<Response> {
	const form = new FormData();
	// Create a fresh ArrayBuffer-backed view so Blob's BlobPart typing accepts it.
	const buf = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buf).set(bytes);
	const blob = new Blob([buf], { type: mime });
	form.append("file", blob, filename);
	const headers: Record<string, string> = opts.cookie === false ? {} : authHeaders();
	if (opts.contentLength != null) {
		headers["content-length"] = String(opts.contentLength);
	}
	return handleUiRequest(
		new Request("http://localhost/ui/api/identity/avatar", {
			method: "POST",
			body: form,
			headers,
		}),
	);
}

const deleteAvatar = (opts: { cookie?: boolean } = {}) =>
	handleUiRequest(
		new Request("http://localhost/ui/api/identity/avatar", {
			method: "DELETE",
			headers: opts.cookie === false ? {} : authHeaders(),
		}),
	);
const getAvatar = (extra: Record<string, string> = {}) =>
	handleUiRequest(new Request("http://localhost/ui/avatar", { method: "GET", headers: publicHeaders(extra) }));

describe("identity avatar API", () => {
	test("401 on POST without cookie", async () => {
		const res = await postAvatar("image/png", pngBytes(), "logo.png", { cookie: false });
		expect(res.status).toBe(401);
	});

	test("401 on DELETE without cookie", async () => {
		const res = await deleteAvatar({ cookie: false });
		expect(res.status).toBe(401);
	});

	test("GET /ui/avatar is public (no cookie required) and 404s with no upload", async () => {
		const res = await getAvatar();
		expect(res.status).toBe(404);
	});

	test("POST with PNG writes file + meta and returns 200", async () => {
		const bytes = pngBytes(200);
		const res = await postAvatar("image/png", bytes, "logo.png");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; url: string; size: number; mime: string };
		expect(body.ok).toBe(true);
		expect(body.url).toBe("/ui/avatar");
		expect(body.size).toBe(bytes.byteLength);
		expect(body.mime).toBe("image/png");
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(true);
		const meta = JSON.parse(readFileSync(join(tmpDir, "avatar.meta.json"), "utf-8")) as {
			ext: string;
			mime: string;
			size: number;
			sha256: string;
		};
		expect(meta.ext).toBe("png");
		expect(meta.mime).toBe("image/png");
		expect(meta.size).toBe(bytes.byteLength);
		expect(meta.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	});

	test("POST with JPEG writes .jpg on disk", async () => {
		const res = await postAvatar("image/jpeg", jpegBytes(), "photo.jpeg");
		expect(res.status).toBe(200);
		expect(existsSync(join(tmpDir, "avatar.jpg"))).toBe(true);
		const meta = JSON.parse(readFileSync(join(tmpDir, "avatar.meta.json"), "utf-8")) as { mime: string };
		expect(meta.mime).toBe("image/jpeg");
	});

	test("POST with WebP writes .webp on disk", async () => {
		const res = await postAvatar("image/webp", webpBytes(), "logo.webp");
		expect(res.status).toBe(200);
		expect(existsSync(join(tmpDir, "avatar.webp"))).toBe(true);
	});

	test("POST with SVG MIME rejected 400, no file written", async () => {
		const res = await postAvatar("image/svg+xml", svgBytes(), "logo.svg");
		expect(res.status).toBe(400);
		expect(existsSync(join(tmpDir, "avatar.svg"))).toBe(false);
		expect(existsSync(join(tmpDir, "avatar.meta.json"))).toBe(false);
	});

	test("POST with SVG bytes but MIME=image/png rejected by magic-byte sniff", async () => {
		const res = await postAvatar("image/png", svgBytes(), "logo.png");
		expect(res.status).toBe(400);
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(false);
	});

	test("POST with PNG magic bytes but MIME=image/jpeg rejected by magic-byte sniff", async () => {
		const res = await postAvatar("image/jpeg", pngBytes(), "logo.jpg");
		expect(res.status).toBe(400);
		expect(existsSync(join(tmpDir, "avatar.jpg"))).toBe(false);
	});

	test("POST with HEIC rejected 400", async () => {
		const res = await postAvatar("image/heic", pngBytes(), "photo.heic");
		expect(res.status).toBe(400);
	});

	test("POST with GIF rejected 400", async () => {
		const res = await postAvatar("image/gif", pngBytes(), "logo.gif");
		expect(res.status).toBe(400);
	});

	test("POST over 2MB via content-length header returns 413", async () => {
		const bytes = pngBytes(16);
		const res = await postAvatar("image/png", bytes, "logo.png", { contentLength: 3 * 1024 * 1024 });
		expect(res.status).toBe(413);
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(false);
	});

	test("POST over 2MB at read-time returns 413 even if Content-Length is absent", async () => {
		// Simulate a >2MB PNG payload. Content-Length is not set manually so Bun
		// computes it from the form, but the handler re-checks after reading.
		const bytes = pngBytes(2 * 1024 * 1024 + 100);
		const res = await postAvatar("image/png", bytes, "logo.png");
		expect(res.status).toBe(413);
	});

	test("POST with traversal filename has extension derived from MIME, path is hardcoded", async () => {
		const bytes = pngBytes();
		const res = await postAvatar("image/png", bytes, "../../etc/passwd.png");
		expect(res.status).toBe(200);
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(true);
		// Nothing else got written outside tmpDir.
		expect(existsSync(join(tmpDir, "..", "etc"))).toBe(false);
	});

	test("POST replaces previous avatar with different extension (PNG -> WebP)", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(true);

		const res = await postAvatar("image/webp", webpBytes(), "logo.webp");
		expect(res.status).toBe(200);
		expect(existsSync(join(tmpDir, "avatar.webp"))).toBe(true);
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(false);
	});

	test("DELETE removes avatar + meta and returns 204", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(true);
		const res = await deleteAvatar();
		expect(res.status).toBe(204);
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(false);
		expect(existsSync(join(tmpDir, "avatar.meta.json"))).toBe(false);
	});

	test("DELETE is idempotent: returns 204 even when no avatar exists", async () => {
		const res = await deleteAvatar();
		expect(res.status).toBe(204);
	});

	test("GET returns bytes with correct Content-Type", async () => {
		const bytes = jpegBytes(50);
		await postAvatar("image/jpeg", bytes, "logo.jpg");
		const res = await getAvatar();
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/jpeg");
		expect(res.headers.get("Cache-Control")).toContain("max-age=300");
		const got = new Uint8Array(await res.arrayBuffer());
		expect(got.byteLength).toBe(bytes.byteLength);
	});

	test("GET with If-None-Match matching ETag returns 304", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		const first = await getAvatar();
		const etag = first.headers.get("ETag");
		expect(etag).toBeTruthy();
		const second = await getAvatar({ "If-None-Match": etag ?? "" });
		expect(second.status).toBe(304);
		expect(second.headers.get("ETag")).toBe(etag);
	});

	test("GET with non-matching ETag returns 200 and new ETag", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		const res = await getAvatar({ "If-None-Match": '"stale"' });
		expect(res.status).toBe(200);
	});

	test("GET 404 when meta exists but file is missing", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		// Clobber the image bytes but leave the meta in place.
		const { unlinkSync } = await import("node:fs");
		unlinkSync(join(tmpDir, "avatar.png"));
		const res = await getAvatar();
		expect(res.status).toBe(404);
	});

	test("POST rejects empty file with 400", async () => {
		const res = await postAvatar("image/png", new Uint8Array(0), "empty.png");
		expect(res.status).toBe(400);
	});

	test("POST rejects missing file with 400", async () => {
		const form = new FormData();
		form.append("other", "nofile");
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/identity/avatar", {
				method: "POST",
				body: form,
				headers: authHeaders(),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("POST unknown MIME rejected", async () => {
		const res = await postAvatar("application/pdf", pngBytes(), "logo.pdf");
		expect(res.status).toBe(400);
	});

	test("atomic rename: tmp files are not left behind on success", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		expect(existsSync(join(tmpDir, "avatar.png.tmp"))).toBe(false);
		expect(existsSync(join(tmpDir, "avatar.meta.json.tmp"))).toBe(false);
	});

	test("pre-existing stale meta + stale file: new upload cleans prior extension", async () => {
		// Seed the directory as if a prior deployment wrote a .gif (old allowlist).
		// The handler must remove it on the next successful upload.
		writeFileSync(join(tmpDir, "avatar.gif"), new Uint8Array([0x47, 0x49, 0x46, 0x38]));
		await postAvatar("image/png", pngBytes(), "logo.png");
		expect(existsSync(join(tmpDir, "avatar.gif"))).toBe(false);
		expect(existsSync(join(tmpDir, "avatar.png"))).toBe(true);
	});

	test("GET /ui/avatar other methods return 405", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/avatar", { method: "POST", headers: publicHeaders() }),
		);
		expect(res.status).toBe(405);
	});

	test("/ui/api/identity/avatar unsupported method returns 405", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/identity/avatar", { method: "GET", headers: authHeaders() }),
		);
		expect(res.status).toBe(405);
	});

	// Wire-contract helpers. These back /health avatar_url, /chat/bootstrap
	// avatar_url, and the dynamic manifest's icon[] section. Test the helpers
	// directly rather than the full HTTP round-trip because /health and the
	// manifest live in core/server.ts and chat/http.ts, which have their own
	// handlers outside handleUiRequest's scope.

	test("avatarUrlIfPresent returns null when no avatar exists", () => {
		expect(avatarUrlIfPresent()).toBeNull();
	});

	test("avatarUrlIfPresent returns /ui/avatar once an avatar is on disk", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		expect(avatarUrlIfPresent()).toBe("/ui/avatar");
	});

	test("avatarUrlIfPresent returns null again after DELETE", async () => {
		await postAvatar("image/png", pngBytes(), "logo.png");
		await handleUiRequest(
			new Request("http://localhost/ui/api/identity/avatar", { method: "DELETE", headers: authHeaders() }),
		);
		expect(avatarUrlIfPresent()).toBeNull();
	});

	test("readAvatarMetaForManifest returns the mime of the uploaded avatar", async () => {
		await postAvatar("image/jpeg", jpegBytes(30), "logo.jpg");
		expect(readAvatarMetaForManifest()).toEqual({ mime: "image/jpeg" });
	});

	test("readAvatarMetaForManifest returns null when no avatar exists", () => {
		expect(readAvatarMetaForManifest()).toBeNull();
	});
});
