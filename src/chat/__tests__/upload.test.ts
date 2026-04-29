import { describe, expect, test } from "bun:test";
import {
	MAX_FILES_PER_REQUEST,
	guessMimeFromName,
	isAllowedMimeType,
	pickExtension,
	sanitizeFilename,
	validateFile,
	validateRequestSize,
} from "../validators.ts";

describe("validators", () => {
	describe("validateFile", () => {
		test("accepts PNG image", () => {
			const result = validateFile("image/png", 1024, "screenshot.png");
			expect(result.ok).toBe(true);
		});

		test("accepts JPEG image", () => {
			const result = validateFile("image/jpeg", 2048, "photo.jpg");
			expect(result.ok).toBe(true);
		});

		test("accepts GIF image", () => {
			const result = validateFile("image/gif", 512, "animation.gif");
			expect(result.ok).toBe(true);
		});

		test("accepts WebP image", () => {
			const result = validateFile("image/webp", 1024, "photo.webp");
			expect(result.ok).toBe(true);
		});

		test("accepts PDF", () => {
			const result = validateFile("application/pdf", 5 * 1024 * 1024, "document.pdf");
			expect(result.ok).toBe(true);
		});

		test("accepts text/plain", () => {
			const result = validateFile("text/plain", 512, "readme.txt");
			expect(result.ok).toBe(true);
		});

		test("accepts text/markdown", () => {
			const result = validateFile("text/markdown", 256, "notes.md");
			expect(result.ok).toBe(true);
		});

		test("accepts application/json", () => {
			const result = validateFile("application/json", 1024, "data.json");
			expect(result.ok).toBe(true);
		});

		test("accepts text/csv", () => {
			const result = validateFile("text/csv", 512, "data.csv");
			expect(result.ok).toBe(true);
		});

		test("accepts text/html", () => {
			const result = validateFile("text/html", 1024, "page.html");
			expect(result.ok).toBe(true);
		});

		test("accepts text/css", () => {
			const result = validateFile("text/css", 256, "styles.css");
			expect(result.ok).toBe(true);
		});

		test("accepts text/javascript", () => {
			const result = validateFile("text/javascript", 512, "app.js");
			expect(result.ok).toBe(true);
		});

		test("accepts file by extension when mime is empty", () => {
			const result = validateFile("", 256, "script.py");
			expect(result.ok).toBe(true);
		});

		test("accepts TypeScript by extension", () => {
			const result = validateFile("", 512, "utils.ts");
			expect(result.ok).toBe(true);
		});

		test("rejects HEIC with iOS-specific message", () => {
			const result = validateFile("image/heic", 1024, "IMG_4221.HEIC");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("unsupported_image_format");
				expect(result.message).toContain("HEIC");
				expect(result.message).toContain("JPEG");
			}
		});

		test("rejects HEIF with iOS-specific message", () => {
			const result = validateFile("image/heif", 1024, "photo.heif");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain("HEIC");
			}
		});

		test("rejects oversized image (> 10MB)", () => {
			const result = validateFile("image/png", 11 * 1024 * 1024, "huge.png");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("image_too_large");
			}
		});

		test("rejects oversized PDF (> 32MB)", () => {
			const result = validateFile("application/pdf", 33 * 1024 * 1024, "huge.pdf");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("pdf_too_large");
			}
		});

		test("rejects oversized text file (> 1MB)", () => {
			const result = validateFile("text/plain", 2 * 1024 * 1024, "huge.txt");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("text_too_large");
			}
		});

		test("rejects empty file", () => {
			const result = validateFile("image/png", 0, "empty.png");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("empty");
			}
		});

		test("rejects unknown MIME type", () => {
			const result = validateFile("application/octet-stream", 1024, "file.bin");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("unsupported_type");
			}
		});

		test("rejects unsupported image format (TIFF)", () => {
			const result = validateFile("image/tiff", 1024, "scan.tiff");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("unsupported_image_format");
			}
		});

		test("rejects executable files", () => {
			const result = validateFile("application/x-executable", 1024, "app.exe");
			expect(result.ok).toBe(false);
		});

		test("rejects files with unknown type and no extension", () => {
			const result = validateFile("", 1024, "noext");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("unknown_type");
			}
		});
	});

	describe("validateRequestSize", () => {
		test("accepts normal request size", () => {
			const result = validateRequestSize(5 * 1024 * 1024);
			expect(result.ok).toBe(true);
		});

		test("rejects oversized request (> 40MB)", () => {
			const result = validateRequestSize(41 * 1024 * 1024);
			expect(result.ok).toBe(false);
		});

		test("accepts null content length", () => {
			const result = validateRequestSize(null);
			expect(result.ok).toBe(true);
		});
	});

	describe("sanitizeFilename", () => {
		test("strips path separators", () => {
			const result = sanitizeFilename("../../../etc/passwd");
			expect(result).not.toContain("/");
			expect(result).not.toContain("\\");
		});

		test("strips special characters", () => {
			expect(sanitizeFilename('file<name>.t"x"t')).toBe("file_name_.t_x_t");
		});

		test("strips leading dots", () => {
			expect(sanitizeFilename("...hidden")).toBe("_hidden");
		});

		test("truncates to 200 characters", () => {
			const longName = `${"a".repeat(250)}.txt`;
			expect(sanitizeFilename(longName).length).toBe(200);
		});

		test("leaves safe filenames unchanged", () => {
			expect(sanitizeFilename("screenshot.png")).toBe("screenshot.png");
		});
	});

	describe("isAllowedMimeType", () => {
		test("allows image/png", () => {
			expect(isAllowedMimeType("image/png", "test.png")).toBe(true);
		});

		test("allows application/pdf", () => {
			expect(isAllowedMimeType("application/pdf", "doc.pdf")).toBe(true);
		});

		test("allows text/plain", () => {
			expect(isAllowedMimeType("text/plain", "file.txt")).toBe(true);
		});

		test("allows .py by extension", () => {
			expect(isAllowedMimeType("", "script.py")).toBe(true);
		});

		test("rejects application/zip", () => {
			expect(isAllowedMimeType("application/zip", "archive.zip")).toBe(false);
		});
	});

	describe("guessMimeFromName", () => {
		test("guesses image/jpeg for .jpg", () => {
			expect(guessMimeFromName("photo.jpg")).toBe("image/jpeg");
		});

		test("guesses image/png for .png", () => {
			expect(guessMimeFromName("screenshot.png")).toBe("image/png");
		});

		test("guesses application/pdf for .pdf", () => {
			expect(guessMimeFromName("doc.pdf")).toBe("application/pdf");
		});

		test("guesses text/plain for .py", () => {
			expect(guessMimeFromName("script.py")).toBe("text/plain");
		});

		test("returns null for unknown extension", () => {
			expect(guessMimeFromName("file.xyz")).toBeNull();
		});

		test("returns null for no extension", () => {
			expect(guessMimeFromName("README")).toBeNull();
		});
	});

	describe("pickExtension", () => {
		test("uses filename extension when available", () => {
			expect(pickExtension("image/png", "screenshot.png")).toBe("png");
		});

		test("falls back to mime for jpeg", () => {
			expect(pickExtension("image/jpeg", "image")).toBe("jpg");
		});

		test("falls back to bin for unknown", () => {
			expect(pickExtension("application/octet-stream", "blob")).toBe("bin");
		});
	});

	describe("MAX_FILES_PER_REQUEST", () => {
		test("is 10", () => {
			expect(MAX_FILES_PER_REQUEST).toBe(10);
		});
	});
});
