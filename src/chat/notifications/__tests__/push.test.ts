import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../../db/schema.ts";
import {
	getActiveSubscriptions,
	getSubscriptionCount,
	recordError,
	recordSuccess,
	removeGone,
	subscribe,
	unsubscribe,
} from "../subscriptions.ts";
import { getOrCreateVapidKeys } from "../vapid.ts";

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	for (const migration of MIGRATIONS) {
		db.run(migration);
	}
});

afterEach(() => {
	db.close();
});

describe("subscriptions CRUD", () => {
	test("subscribe inserts a new subscription", () => {
		subscribe(db, {
			endpoint: "https://push.example.com/sub1",
			p256dh: "test-p256dh",
			auth: "test-auth",
			userAgent: "TestBrowser/1.0",
		});
		expect(getSubscriptionCount(db)).toBe(1);
		const subs = getActiveSubscriptions(db);
		expect(subs.length).toBe(1);
		expect(subs[0]?.endpoint).toBe("https://push.example.com/sub1");
		expect(subs[0]?.p256dh).toBe("test-p256dh");
	});

	test("subscribe upserts on existing endpoint", () => {
		subscribe(db, {
			endpoint: "https://push.example.com/sub1",
			p256dh: "old-key",
			auth: "old-auth",
		});
		subscribe(db, {
			endpoint: "https://push.example.com/sub1",
			p256dh: "new-key",
			auth: "new-auth",
		});
		expect(getSubscriptionCount(db)).toBe(1);
		const subs = getActiveSubscriptions(db);
		expect(subs[0]?.p256dh).toBe("new-key");
	});

	test("subscribe resets consecutive_errors on re-subscribe", () => {
		subscribe(db, {
			endpoint: "https://push.example.com/sub1",
			p256dh: "key",
			auth: "auth",
		});
		// Simulate errors
		for (let i = 0; i < 5; i++) {
			recordError(db, "https://push.example.com/sub1");
		}
		const before = getActiveSubscriptions(db);
		expect(before[0]?.consecutive_errors).toBe(5);

		// Re-subscribe resets
		subscribe(db, {
			endpoint: "https://push.example.com/sub1",
			p256dh: "key",
			auth: "auth",
		});
		const after = getActiveSubscriptions(db);
		expect(after[0]?.consecutive_errors).toBe(0);
	});

	test("unsubscribe removes subscription", () => {
		subscribe(db, { endpoint: "https://push.example.com/sub1", p256dh: "k", auth: "a" });
		expect(getSubscriptionCount(db)).toBe(1);
		unsubscribe(db, "https://push.example.com/sub1");
		expect(getSubscriptionCount(db)).toBe(0);
	});

	test("recordSuccess updates last_success_at and resets errors", () => {
		subscribe(db, { endpoint: "https://push.example.com/sub1", p256dh: "k", auth: "a" });
		recordError(db, "https://push.example.com/sub1");
		recordSuccess(db, "https://push.example.com/sub1");
		const subs = getActiveSubscriptions(db);
		expect(subs[0]?.consecutive_errors).toBe(0);
		expect(subs[0]?.last_success_at).not.toBeNull();
	});

	test("10+ errors disables subscription", () => {
		subscribe(db, { endpoint: "https://push.example.com/sub1", p256dh: "k", auth: "a" });
		for (let i = 0; i < 10; i++) {
			recordError(db, "https://push.example.com/sub1");
		}
		// Should be disabled now, not in active list
		expect(getActiveSubscriptions(db).length).toBe(0);
		expect(getSubscriptionCount(db)).toBe(0);
	});

	test("removeGone deletes subscription", () => {
		subscribe(db, { endpoint: "https://push.example.com/sub1", p256dh: "k", auth: "a" });
		removeGone(db, "https://push.example.com/sub1");
		expect(getSubscriptionCount(db)).toBe(0);
	});
});

describe("VAPID key generation", () => {
	test("generates and persists VAPID key pair", async () => {
		const keys = await getOrCreateVapidKeys(db);
		expect(keys.publicKey).toBeTruthy();
		expect(keys.privateKey).toBeTruthy();
		expect(typeof keys.publicKey).toBe("string");
		expect(typeof keys.privateKey).toBe("string");
	});

	test("returns same keys on second call", async () => {
		const first = await getOrCreateVapidKeys(db);
		const second = await getOrCreateVapidKeys(db);
		expect(second.publicKey).toBe(first.publicKey);
		expect(second.privateKey).toBe(first.privateKey);
	});

	test("public key is valid base64url", async () => {
		const keys = await getOrCreateVapidKeys(db);
		// base64url should not contain + / or =
		expect(keys.publicKey).not.toMatch(/[+/=]/);
	});
});

describe("Bun Web Crypto smoke test", () => {
	test("generates ECDSA P-256 key pair", async () => {
		const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		expect(keyPair.publicKey).toBeTruthy();
		expect(keyPair.privateKey).toBeTruthy();
	});

	test("exports and reimports a key pair round-trip", async () => {
		const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
		expect(jwk.kty).toBe("EC");
		expect(jwk.crv).toBe("P-256");
		expect(jwk.d).toBeTruthy();

		const reimported = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
		]);
		expect(reimported).toBeTruthy();
	});

	test("signs and verifies with ECDSA P-256", async () => {
		const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		const data = new TextEncoder().encode("test payload for push notification");
		const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, data);
		expect(signature.byteLength).toBeGreaterThan(0);

		const isValid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keyPair.publicKey, signature, data);
		expect(isValid).toBe(true);
	});

	test("ECDH deriveBits produces shared secret", async () => {
		const alice = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const bob = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);

		const aliceShared = await crypto.subtle.deriveBits({ name: "ECDH", public: bob.publicKey }, alice.privateKey, 256);
		const bobShared = await crypto.subtle.deriveBits({ name: "ECDH", public: alice.publicKey }, bob.privateKey, 256);

		expect(aliceShared.byteLength).toBe(32);
		const aliceArr = new Uint8Array(aliceShared);
		const bobArr = new Uint8Array(bobShared);
		expect(aliceArr).toEqual(bobArr);
	});
});
