// VAPID key pair management for Web Push.
// Keys are persisted in the encrypted secrets table so they survive restarts.
// The public key is base64url-encoded for the client's pushManager.subscribe().

import type { Database } from "bun:sqlite";
import { encryptSecret } from "../../secrets/crypto.ts";
import { getSecret } from "../../secrets/store.ts";

const PUBLIC_KEY_NAME = "chat_vapid_public_key";
const PRIVATE_KEY_NAME = "chat_vapid_private_key";

export type VapidKeyPair = {
	publicKey: string; // base64url
	privateKey: string; // base64url
};

function storeSecret(db: Database, name: string, value: string, fieldType: string): void {
	const { encrypted, iv, authTag } = encryptSecret(value);
	db.run(
		`INSERT OR REPLACE INTO secrets (name, encrypted_value, iv, auth_tag, field_type, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		[name, encrypted, iv, authTag, fieldType],
	);
}

export async function getOrCreateVapidKeys(db: Database): Promise<VapidKeyPair> {
	// Try loading existing keys
	const existingPublic = getSecret(db, PUBLIC_KEY_NAME);
	const existingPrivate = getSecret(db, PRIVATE_KEY_NAME);

	if (existingPublic && existingPrivate) {
		return {
			publicKey: existingPublic.value,
			privateKey: existingPrivate.value,
		};
	}

	// Generate a fresh ECDSA P-256 key pair via Web Crypto
	const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

	// Export raw public key (65 bytes uncompressed) to base64url
	const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
	const publicKeyB64 = arrayBufferToBase64Url(rawPublic);

	// Export private key as JWK, extract the "d" parameter (32 bytes base64url)
	const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
	if (!jwk.d) {
		throw new Error("Failed to export VAPID private key: missing d parameter");
	}
	const privateKeyB64 = jwk.d;

	// Persist both keys
	storeSecret(db, PUBLIC_KEY_NAME, publicKeyB64, "text");
	storeSecret(db, PRIVATE_KEY_NAME, privateKeyB64, "password");

	console.log("[push] Generated and stored new VAPID key pair");

	return {
		publicKey: publicKeyB64,
		privateKey: privateKeyB64,
	};
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
