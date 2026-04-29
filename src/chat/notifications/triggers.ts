// Notification trigger logic. Wires into the chat writer and scheduler
// to fire push notifications when appropriate conditions are met.

import type { Database } from "bun:sqlite";
import type { SessionFocusMap } from "./focus.ts";
import {
	type NotificationPayload,
	agentMessagePayload,
	hardErrorPayload,
	scheduledJobPayload,
	sessionCompletePayload,
} from "./payload.ts";
import { broadcastNotification } from "./sender.ts";
import type { VapidKeyPair } from "./vapid.ts";

const MIN_SESSION_DURATION_MS = 30_000; // 30 seconds
const DEBOUNCE_WINDOW_MS = 5_000; // 5 seconds per tag

export class NotificationTriggerService {
	private db: Database;
	private vapidKeys: VapidKeyPair;
	private focusMap: SessionFocusMap;
	private ownerEmail?: string;
	private lastFiredAt = new Map<string, number>();

	constructor(opts: {
		db: Database;
		vapidKeys: VapidKeyPair;
		focusMap: SessionFocusMap;
		ownerEmail?: string;
	}) {
		this.db = opts.db;
		this.vapidKeys = opts.vapidKeys;
		this.focusMap = opts.focusMap;
		this.ownerEmail = opts.ownerEmail;
	}

	getFocusMap(): SessionFocusMap {
		return this.focusMap;
	}

	async onSessionDone(sessionId: string, durationMs: number, title: string): Promise<void> {
		if (durationMs < MIN_SESSION_DURATION_MS) return;
		if (this.focusMap.isFocused(sessionId)) return;

		const payload = sessionCompletePayload(sessionId, title, durationMs);
		if (this.isDebouncedRecently(payload.tag)) return;

		await this.broadcast(payload);
	}

	async onAgentMessage(sessionId: string, preview: string): Promise<void> {
		if (this.focusMap.isFocused(sessionId)) return;

		const payload = agentMessagePayload(sessionId, preview);
		if (this.isDebouncedRecently(payload.tag)) return;

		await this.broadcast(payload);
	}

	async onScheduledJobResult(jobName: string, status: string): Promise<void> {
		const payload = scheduledJobPayload(jobName, status);
		if (this.isDebouncedRecently(payload.tag)) return;

		await this.broadcast(payload);
	}

	async onHardError(sessionId: string, error: string): Promise<void> {
		const payload = hardErrorPayload(sessionId, error);
		if (this.isDebouncedRecently(payload.tag)) return;

		await this.broadcast(payload);
	}

	private isDebouncedRecently(tag: string): boolean {
		const now = Date.now();
		const last = this.lastFiredAt.get(tag);
		if (last && now - last < DEBOUNCE_WINDOW_MS) return true;
		this.lastFiredAt.set(tag, now);
		return false;
	}

	private async broadcast(payload: NotificationPayload): Promise<void> {
		try {
			const result = await broadcastNotification(this.db, payload, this.vapidKeys, this.ownerEmail);
			if (result.sent > 0) {
				console.log(`[push] Sent ${result.sent} notification(s): ${payload.title}`);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[push] Broadcast failed: ${msg}`);
		}
	}
}
