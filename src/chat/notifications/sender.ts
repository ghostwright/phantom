// @block65/webcrypto-web-push wrapper for sending push notifications.
// Handles HTTP status codes from the push service and updates subscription
// health in the database.

import type { Database } from "bun:sqlite";
import { type PushMessage, type PushSubscription, buildPushPayload } from "@block65/webcrypto-web-push";
import type { NotificationPayload } from "./payload.ts";
import { getActiveSubscriptions, recordError, recordSuccess, removeGone } from "./subscriptions.ts";
import type { VapidKeyPair } from "./vapid.ts";

type SendResult = {
	ok: boolean;
	reason?: string;
	statusCode?: number;
};

export async function sendPushNotification(
	subscription: { endpoint: string; p256dh: string; auth: string },
	payload: NotificationPayload,
	vapidKeys: VapidKeyPair,
	db: Database,
	ownerEmail?: string,
): Promise<SendResult> {
	const pushSub: PushSubscription = {
		endpoint: subscription.endpoint,
		expirationTime: null,
		keys: {
			p256dh: subscription.p256dh,
			auth: subscription.auth,
		},
	};

	const message: PushMessage = {
		data: JSON.stringify(payload),
		options: {
			ttl: 86400,
			urgency: "normal",
			topic: payload.tag,
		},
	};

	const vapid = {
		subject: ownerEmail ? `mailto:${ownerEmail}` : "mailto:noreply@phantom.dev",
		publicKey: vapidKeys.publicKey,
		privateKey: vapidKeys.privateKey,
	};

	try {
		const fetchInit = await buildPushPayload(message, pushSub, vapid);
		const res = await fetch(subscription.endpoint, {
			...fetchInit,
			body: fetchInit.body as unknown as BodyInit,
		});

		if (res.status === 201 || res.status === 200) {
			recordSuccess(db, subscription.endpoint);
			return { ok: true };
		}

		if (res.status === 410 || res.status === 404) {
			removeGone(db, subscription.endpoint);
			return { ok: false, reason: "gone", statusCode: res.status };
		}

		if (res.status === 429) {
			console.warn("[push] Rate limited by push service, skipping");
			return { ok: false, reason: "rate-limited", statusCode: 429 };
		}

		if (res.status >= 500) {
			recordError(db, subscription.endpoint);
			return { ok: false, reason: "server-error", statusCode: res.status };
		}

		// 400, 401, 403: programming or config error
		console.error(`[push] Push service rejected: ${res.status}`);
		return { ok: false, reason: "rejected", statusCode: res.status };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[push] sendPushNotification threw: ${msg}`);
		return { ok: false, reason: "network-error" };
	}
}

export async function broadcastNotification(
	db: Database,
	payload: NotificationPayload,
	vapidKeys: VapidKeyPair,
	ownerEmail?: string,
): Promise<{ sent: number; failed: number }> {
	const subscriptions = getActiveSubscriptions(db);
	if (subscriptions.length === 0) return { sent: 0, failed: 0 };

	const results = await Promise.allSettled(
		subscriptions.map((sub) =>
			sendPushNotification(
				{ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
				payload,
				vapidKeys,
				db,
				ownerEmail,
			),
		),
	);

	let sent = 0;
	let failed = 0;
	for (const result of results) {
		if (result.status === "fulfilled" && result.value.ok) {
			sent++;
		} else {
			failed++;
		}
	}

	return { sent, failed };
}
