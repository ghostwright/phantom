// Avatar upload endpoints. Single operator-visible identity asset on disk at
// data/identity/avatar.<ext> + avatar.meta.json. All three serve paths
// (/ui/avatar, /chat/icon, /health avatar_url) share one reader so the bytes
// only live in one place.
//
// Security posture:
//   - Server never decodes the image. Bun writes bytes verbatim; the browser
//     decodes in its sandbox.
//   - MIME allowlist: PNG, JPEG, WebP. SVG rejected at MIME AND via magic-byte
//     sniff because some form parse libs derive MIME from the filename.
//   - Extension is derived from the validated MIME, never from the uploaded
//     filename. Path is hardcoded so traversal is impossible.
//   - 2MB cap at content-length AND at read. Both checks required (the
//     Content-Length header can lie or be absent).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

let identityDirOverride: string | null = null;

export function setIdentityDirForTests(dir: string | null): void {
	identityDirOverride = dir;
}

export function getIdentityDir(): string {
	return identityDirOverride ?? resolve(process.cwd(), "data", "identity");
}

type AvatarMeta = {
	ext: "png" | "jpg" | "webp";
	mime: string;
	size: number;
	uploaded_at: string;
	sha256: string;
};

function metaPath(): string {
	return resolve(getIdentityDir(), "avatar.meta.json");
}

function avatarPath(ext: string): string {
	return resolve(getIdentityDir(), `avatar.${ext}`);
}

function readMetaSync(): AvatarMeta | null {
	const p = metaPath();
	if (!existsSync(p)) return null;
	try {
		const text = readFileSync(p, "utf-8");
		const parsed = JSON.parse(text) as AvatarMeta;
		if (!parsed || typeof parsed.ext !== "string" || typeof parsed.mime !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

export function hasAvatar(): boolean {
	const meta = readMetaSync();
	if (!meta) return false;
	return existsSync(avatarPath(meta.ext));
}

export function avatarUrlIfPresent(): string | null {
	return hasAvatar() ? "/ui/avatar" : null;
}

// Manifest consumer needs the MIME to set the icons[].type correctly so
// Android/iOS pick the right entry. Returns null when no avatar is uploaded.
export function readAvatarMetaForManifest(): { mime: string } | null {
	const meta = readMetaSync();
	if (!meta) return null;
	if (!existsSync(avatarPath(meta.ext))) return null;
	return { mime: meta.mime };
}

function extFromMime(mime: string): "png" | "jpg" | "webp" | null {
	if (mime === "image/png") return "png";
	if (mime === "image/jpeg") return "jpg";
	if (mime === "image/webp") return "webp";
	return null;
}

// Magic-byte sniff. Even if the MIME check is bypassed, this catches SVG
// masquerading as PNG (opening `3C 3F 78 6D 6C` or `3C 73 76 67`) and other
// format swaps. Defense in depth.
function sniffMatches(bytes: Uint8Array, mime: string): boolean {
	if (bytes.length < 12) return false;
	if (mime === "image/png") {
		return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	}
	if (mime === "image/jpeg") {
		return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	}
	if (mime === "image/webp") {
		const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
		const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
		return riff && webp;
	}
	return false;
}

function errJson(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export async function handleAvatarPost(req: Request): Promise<Response> {
	const contentLengthHeader = req.headers.get("content-length");
	if (contentLengthHeader !== null) {
		const cl = Number(contentLengthHeader);
		if (Number.isFinite(cl) && cl > MAX_BYTES) {
			return errJson("Avatar too large. Max 2 MB.", 413);
		}
	}

	let formData: FormData;
	try {
		formData = await req.formData();
	} catch {
		return errJson("Could not parse multipart form data.", 400);
	}

	const files = formData.getAll("file").filter((v): v is File => v instanceof File);
	if (files.length === 0) return errJson("No file attached.", 400);
	if (files.length > 1) return errJson("Exactly one file is required.", 400);

	const file = files[0];
	const mime = file.type;
	if (!ALLOWED_MIMES.has(mime)) {
		return errJson("Unsupported image type. Use PNG, JPEG, or WebP.", 400);
	}

	if (file.size === 0) return errJson("File is empty.", 400);
	if (file.size > MAX_BYTES) return errJson("Avatar too large. Max 2 MB.", 413);

	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.byteLength > MAX_BYTES) return errJson("Avatar too large. Max 2 MB.", 413);

	if (!sniffMatches(bytes, mime)) {
		return errJson("File bytes do not match declared type.", 400);
	}

	const ext = extFromMime(mime);
	if (!ext) return errJson("Unsupported image type. Use PNG, JPEG, or WebP.", 400);

	const dir = getIdentityDir();
	mkdirSync(dir, { recursive: true });

	const targetFile = avatarPath(ext);
	const tmpFile = `${targetFile}.tmp`;
	const targetMeta = metaPath();
	const tmpMeta = `${targetMeta}.tmp`;

	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const meta: AvatarMeta = {
		ext,
		mime,
		size: bytes.byteLength,
		uploaded_at: new Date().toISOString(),
		sha256,
	};

	try {
		writeFileSync(tmpFile, bytes);
		renameSync(tmpFile, targetFile);
	} catch (err: unknown) {
		try {
			if (existsSync(tmpFile)) unlinkSync(tmpFile);
		} catch {}
		const msg = err instanceof Error ? err.message : String(err);
		return errJson(`Avatar write failed: ${msg}`, 500);
	}

	try {
		writeFileSync(tmpMeta, JSON.stringify(meta, null, 2));
		renameSync(tmpMeta, targetMeta);
	} catch (err: unknown) {
		try {
			if (existsSync(tmpMeta)) unlinkSync(tmpMeta);
		} catch {}
		const msg = err instanceof Error ? err.message : String(err);
		return errJson(`Avatar meta write failed: ${msg}`, 500);
	}

	// Prune any previous avatar with a different extension (PNG -> WebP etc).
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith("avatar.")) continue;
		if (entry === `avatar.${ext}` || entry === "avatar.meta.json") continue;
		if (entry.endsWith(".tmp")) continue;
		try {
			unlinkSync(resolve(dir, entry));
		} catch {}
	}

	return Response.json({ ok: true, url: "/ui/avatar", size: bytes.byteLength, mime });
}

export function handleAvatarDelete(): Response {
	const dir = getIdentityDir();
	if (!existsSync(dir)) return new Response(null, { status: 204 });
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith("avatar.")) continue;
		try {
			unlinkSync(resolve(dir, entry));
		} catch {}
	}
	return new Response(null, { status: 204 });
}

export async function handleAvatarGet(req: Request): Promise<Response> {
	const meta = readMetaSync();
	if (!meta) return new Response("Not found", { status: 404 });
	const file = Bun.file(avatarPath(meta.ext));
	if (!(await file.exists())) {
		console.warn("[identity] avatar meta exists but file is missing; returning 404");
		return new Response("Not found", { status: 404 });
	}
	const etag = `"${meta.sha256}"`;
	const ifNoneMatch = req.headers.get("if-none-match");
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, { status: 304, headers: { ETag: etag } });
	}
	return new Response(file, {
		headers: {
			"Content-Type": meta.mime,
			"Cache-Control": "private, max-age=300, must-revalidate",
			ETag: etag,
		},
	});
}
