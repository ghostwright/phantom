// File type allowlist and size validation for chat attachments.
// Single source of truth for both upload validation and type classification.

export const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const VIDEO_MIMES = new Set(["video/mp4", "video/avi", "video/x-msvideo", "video/mov", "video/x-matroska"]);

export const PDF_MIME = "application/pdf";

export const TEXT_MIMES = new Set([
	"text/plain",
	"text/markdown",
	"text/html",
	"text/csv",
	"text/xml",
	"text/css",
	"text/javascript",
	"application/xml",
	"application/json",
	"application/yaml",
	"text/yaml",
]);

export const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".json",
	".csv",
	".html",
	".xml",
	".yaml",
	".yml",
	".toml",
	".ini",
	".sql",
	".js",
	".ts",
	".tsx",
	".jsx",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".kt",
	".swift",
	".c",
	".cpp",
	".h",
	".hpp",
	".sh",
	".bash",
	".zsh",
	".css",
]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 10;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export type ValidationResult = { ok: true } | { ok: false; reason: string; message: string };

function getExtension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	if (dot < 0) return "";
	return filename.slice(dot).toLowerCase();
}

function hasTextExtension(filename: string): boolean {
	return TEXT_EXTENSIONS.has(getExtension(filename));
}

export function guessMimeFromName(filename: string): string | null {
	const ext = getExtension(filename);
	if (!ext) return null;
	if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	if (ext === ".mp4") return "video/mp4";
	if (ext === ".avi") return "video/avi";
	if (ext === ".mov") return "video/mov";
	if (ext === ".mkv") return "video/x-matroska";
	if (ext === ".pdf") return "application/pdf";
	if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
	return null;
}

export function normalizeMimeType(mimeType: string, filename: string): string {
	const mime = mimeType || guessMimeFromName(filename) || "";
	if (mime === "video/quicktime" && getExtension(filename) === ".mov") return "video/mov";
	return mime;
}

export function isAllowedMimeType(mimeType: string, filename: string): boolean {
	const mime = normalizeMimeType(mimeType, filename);
	if (IMAGE_MIMES.has(mime)) return true;
	if (VIDEO_MIMES.has(mime)) return true;
	if (mime === PDF_MIME) return true;
	if (TEXT_MIMES.has(mime)) return true;
	if (hasTextExtension(filename)) return true;
	return false;
}

export function validateFile(mimeType: string, sizeBytes: number, filename: string): ValidationResult {
	if (sizeBytes === 0) return { ok: false, reason: "empty", message: "File is empty." };

	const mime = normalizeMimeType(mimeType, filename);
	if (!mime) return { ok: false, reason: "unknown_type", message: "Unknown file type." };

	if (mime === "image/heic" || mime === "image/heif") {
		return {
			ok: false,
			reason: "unsupported_image_format",
			message: "iOS HEIC photos are not supported. Please choose JPEG export from the Photos app.",
		};
	}

	if (mime.startsWith("image/")) {
		if (!IMAGE_MIMES.has(mime)) {
			return {
				ok: false,
				reason: "unsupported_image_format",
				message: "This image format is not supported. Convert to JPEG, PNG, GIF, or WebP.",
			};
		}
		if (sizeBytes > MAX_IMAGE_BYTES) {
			return { ok: false, reason: "image_too_large", message: "Image is too large. Max 10 MB." };
		}
		return { ok: true };
	}

	if (mime.startsWith("video/")) {
		if (!VIDEO_MIMES.has(mime)) {
			return {
				ok: false,
				reason: "unsupported_video_format",
				message: "This video format is not supported. Convert to MP4, AVI, MOV, or MKV.",
			};
		}
		if (sizeBytes > MAX_VIDEO_BYTES) {
			return { ok: false, reason: "video_too_large", message: "Video is too large. Max 50 MB." };
		}
		return { ok: true };
	}

	if (mime === PDF_MIME) {
		if (sizeBytes > MAX_PDF_BYTES) {
			return { ok: false, reason: "pdf_too_large", message: "PDF is too large. Max 32 MB." };
		}
		return { ok: true };
	}

	if (TEXT_MIMES.has(mime) || hasTextExtension(filename)) {
		if (sizeBytes > MAX_TEXT_BYTES) {
			return { ok: false, reason: "text_too_large", message: "Text file is too large. Max 1 MB." };
		}
		return { ok: true };
	}

	return { ok: false, reason: "unsupported_type", message: "File type not supported." };
}

export function validateRequestSize(contentLength: number | null): ValidationResult {
	if (contentLength !== null && contentLength > MAX_REQUEST_BYTES) {
		return { ok: false, reason: "request_too_large", message: "Total upload too large. Max 64 MB." };
	}
	return { ok: true };
}

export function sanitizeFilename(name: string): string {
	return name
		.replace(/[/\\:*?"<>|]/g, "_")
		.replace(/^\.+/, "_")
		.slice(0, 200);
}

export function pickExtension(mimeType: string, filename: string): string {
	const fromName = getExtension(filename);
	if (fromName && fromName.length > 1) return fromName.slice(1);
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/gif") return "gif";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "video/mp4") return "mp4";
	if (mimeType === "video/avi" || mimeType === "video/x-msvideo") return "avi";
	if (mimeType === "video/mov" || mimeType === "video/quicktime") return "mov";
	if (mimeType === "video/x-matroska") return "mkv";
	if (mimeType === "application/pdf") return "pdf";
	return "bin";
}
