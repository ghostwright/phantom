import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { decryptSecret, encryptSecret, getEncryptionKey, resetKeyCache } from "../crypto.ts";

const TEST_KEY = randomBytes(32).toString("hex");
const TEST_DATA_DIR = "data";
const TEST_KEY_FILE = "data/secret-encryption-key";

// Flip the first base64 character to a guaranteed-different character. The
// old pattern of prepending "X" before slicing failed ~1.5% of runs because
// base64 strings can legitimately start with "X", producing an unchanged
// string and a non-tampered decrypt that succeeded.
function flipFirstBase64Char(s: string): string {
	return s.charAt(0) === "A" ? "B" : "A";
}

beforeEach(() => {
	resetKeyCache();
	// Clean up any auto-generated key file from previous runs
	try {
		rmSync(TEST_KEY_FILE);
	} catch {
		// File may not exist
	}
});

afterEach(() => {
	resetKeyCache();
	process.env.SECRET_ENCRYPTION_KEY = undefined;
	try {
		rmSync(TEST_KEY_FILE);
	} catch {
		// File may not exist
	}
});

describe("getEncryptionKey", () => {
	test("uses SECRET_ENCRYPTION_KEY env var when set", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const key = getEncryptionKey();
		expect(key.length).toBe(32);
		expect(key.toString("hex")).toBe(TEST_KEY);
	});

	test("rejects invalid hex length", () => {
		process.env.SECRET_ENCRYPTION_KEY = "abcdef"; // too short
		expect(() => getEncryptionKey()).toThrow("64 hex chars");
	});

	test("auto-generates key file when no env var", () => {
		process.env.SECRET_ENCRYPTION_KEY = undefined;
		if (!existsSync(TEST_DATA_DIR)) mkdirSync(TEST_DATA_DIR, { recursive: true });

		const key = getEncryptionKey();
		expect(key.length).toBe(32);
		expect(existsSync(TEST_KEY_FILE)).toBe(true);
	});

	test("reads existing key file", () => {
		process.env.SECRET_ENCRYPTION_KEY = undefined;
		if (!existsSync(TEST_DATA_DIR)) mkdirSync(TEST_DATA_DIR, { recursive: true });
		writeFileSync(TEST_KEY_FILE, TEST_KEY);

		const key = getEncryptionKey();
		expect(key.toString("hex")).toBe(TEST_KEY);
	});

	test("caches the key after first read", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const key1 = getEncryptionKey();
		const key2 = getEncryptionKey();
		expect(key1).toBe(key2); // Same buffer reference
	});
});

describe("encrypt / decrypt round-trip", () => {
	test("encrypts and decrypts a simple string", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const plaintext = "glpat-xxxxxxxxxxxxxxxxxxxx";
		const { encrypted, iv, authTag } = encryptSecret(plaintext);
		const decrypted = decryptSecret(encrypted, iv, authTag);
		expect(decrypted).toBe(plaintext);
	});

	test("encrypts and decrypts an empty string", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const { encrypted, iv, authTag } = encryptSecret("");
		const decrypted = decryptSecret(encrypted, iv, authTag);
		expect(decrypted).toBe("");
	});

	test("encrypts and decrypts unicode", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const plaintext = "p@$$w0rd-mit-umlauten-aeoeue";
		const { encrypted, iv, authTag } = encryptSecret(plaintext);
		expect(decryptSecret(encrypted, iv, authTag)).toBe(plaintext);
	});

	test("encrypts and decrypts a long string", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const plaintext = "a".repeat(10000);
		const { encrypted, iv, authTag } = encryptSecret(plaintext);
		expect(decryptSecret(encrypted, iv, authTag)).toBe(plaintext);
	});

	test("produces different ciphertexts for the same plaintext (random IV)", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const plaintext = "same-secret";
		const a = encryptSecret(plaintext);
		const b = encryptSecret(plaintext);
		expect(a.encrypted).not.toBe(b.encrypted);
		expect(a.iv).not.toBe(b.iv);
	});

	test("tampered ciphertext fails decryption", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const { encrypted, iv, authTag } = encryptSecret("sensitive-data");
		const tampered = `${flipFirstBase64Char(encrypted)}${encrypted.slice(1)}`;
		expect(() => decryptSecret(tampered, iv, authTag)).toThrow();
	});

	test("tampered auth tag fails decryption", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const { encrypted, iv, authTag } = encryptSecret("sensitive-data");
		const tampered = `${flipFirstBase64Char(authTag)}${authTag.slice(1)}`;
		expect(() => decryptSecret(encrypted, iv, tampered)).toThrow();
	});

	test("wrong key fails decryption", () => {
		process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
		const { encrypted, iv, authTag } = encryptSecret("sensitive-data");

		resetKeyCache();
		process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString("hex");
		expect(() => decryptSecret(encrypted, iv, authTag)).toThrow();
	});
});
