import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let cachedKey: Buffer | null = null;

/**
 * Resolves the encryption key with two strategies:
 * 1. SECRET_ENCRYPTION_KEY env var (hex-encoded 32 bytes)
 * 2. Auto-generated key file at data/secret-encryption-key
 *
 * The file fallback means bare-metal users who skip the env var
 * still get working encryption. Docker users set the env var.
 */
export function getEncryptionKey(): Buffer {
	if (cachedKey) return cachedKey;

	const envKey = readEnv(process.env.SECRET_ENCRYPTION_KEY);
	if (envKey) {
		const buf = Buffer.from(envKey, "hex");
		if (buf.length !== KEY_LENGTH) {
			throw new Error(`SECRET_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Got ${envKey.length} chars.`);
		}
		cachedKey = buf;
		return cachedKey;
	}

	const keyPath = resolve(process.cwd(), "data/secret-encryption-key");
	try {
		const hex = readFileSync(keyPath, "utf-8").trim();
		const buf = Buffer.from(hex, "hex");
		if (buf.length !== KEY_LENGTH) {
			throw new Error("Stored key has wrong length");
		}
		cachedKey = buf;
		return cachedKey;
	} catch {
		const key = randomBytes(KEY_LENGTH);
		const dir = dirname(keyPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
		cachedKey = key;
		console.log("[secrets] Generated new encryption key at data/secret-encryption-key");
		return cachedKey;
	}
}

export function encryptSecret(plaintext: string): { encrypted: string; iv: string; authTag: string } {
	const key = getEncryptionKey();
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

	let encrypted = cipher.update(plaintext, "utf8", "base64");
	encrypted += cipher.final("base64");
	const authTag = cipher.getAuthTag();

	return {
		encrypted,
		iv: iv.toString("base64"),
		authTag: authTag.toString("base64"),
	};
}

export function decryptSecret(encrypted: string, iv: string, authTag: string): string {
	const key = getEncryptionKey();
	const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"), { authTagLength: TAG_LENGTH });
	decipher.setAuthTag(Buffer.from(authTag, "base64"));

	let decrypted = decipher.update(encrypted, "base64", "utf8");
	decrypted += decipher.final("utf8");
	return decrypted;
}

/** Reset cached key. Used in tests only. */
export function resetKeyCache(): void {
	cachedKey = null;
}

function readEnv(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	return normalized === "" || normalized === "undefined" ? undefined : normalized;
}
