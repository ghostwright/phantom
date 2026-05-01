// Fetch wrapper for the Phantom chat HTTP API.
// All paths are relative to /chat/ and inherit the cookie auth.

import type { DurableRunTimelineSummary } from "./chat-types";

export type BootstrapData = {
	agent_name: string;
	evolution_gen: number;
	avatar_url: string | null;
	memory_count: number;
	slack_status: string;
	scheduled_jobs_count: number;
	recent_sessions_count: number;
	suggestions: string[];
};

export type SessionSummary = {
	id: string;
	title: string | null;
	created_at: string;
	updated_at: string;
	last_message_at: string | null;
	message_count: number;
	total_cost_usd: number;
	pinned: number;
	status: string;
};

export type SessionDetail = SessionSummary & {
	messages: Array<{
		id: string;
		session_id: string;
		seq: number;
		role: string;
		content_json: string;
		created_at: string;
		completed_at: string | null;
		status: string;
		stop_reason: string | null;
		input_tokens: number | null;
		output_tokens: number | null;
		cost_usd: number | null;
		model: string | null;
		error_text: string | null;
	}>;
	stream_state?: {
		max_seq: number;
		latest_terminal_seq: number;
		writer_active: boolean;
		has_incomplete_tail: boolean;
	};
	run_timelines?: Array<{
		id: string;
		session_id: string;
		user_message_id: string;
		assistant_message_id: string | null;
		start_seq: number;
		end_seq: number | null;
		status: DurableRunTimelineSummary["status"];
		started_at: string;
		completed_at: string | null;
		current_label: string | null;
		stop_reason: string | null;
		duration_ms: number | null;
		cost_usd: number | null;
		input_tokens: number | null;
		output_tokens: number | null;
		summary: DurableRunTimelineSummary;
	}>;
};

export type ListSessionsResult = {
	sessions: SessionSummary[];
	next_cursor: string | null;
};

export const SESSIONS_CHANGED_EVENT = "phantom:sessions-changed";

export type SessionsChangedReason = "created" | "updated" | "deleted" | "run-completed";

export function notifySessionsChanged(reason: SessionsChangedReason): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED_EVENT, { detail: { reason } }));
}

async function chatFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		...options,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Chat API error ${res.status}: ${body}`);
	}
	return res.json() as Promise<T>;
}

export function getBootstrap(): Promise<BootstrapData> {
	return chatFetch<BootstrapData>("/chat/bootstrap");
}

export function listSessions(limit = 50, cursor?: string): Promise<ListSessionsResult> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (cursor) params.set("cursor", cursor);
	return chatFetch<ListSessionsResult>(`/chat/sessions?${params}`);
}

export function getSession(id: string): Promise<SessionDetail> {
	return chatFetch<SessionDetail>(`/chat/sessions/${id}`);
}

export async function createSession(title?: string): Promise<{ id: string; created_at: string }> {
	const result = await chatFetch<{ id: string; created_at: string }>("/chat/sessions", {
		method: "POST",
		body: JSON.stringify(title ? { title } : {}),
	});
	notifySessionsChanged("created");
	return result;
}

export async function updateSession(
	id: string,
	fields: { title?: string; pinned?: boolean; status?: string },
): Promise<{ ok: boolean }> {
	const result = await chatFetch<{ ok: boolean }>(`/chat/sessions/${id}`, {
		method: "PATCH",
		body: JSON.stringify(fields),
	});
	notifySessionsChanged("updated");
	return result;
}

export async function deleteSession(id: string): Promise<{ ok: boolean; undo_until: string }> {
	const result = await chatFetch<{ ok: boolean; undo_until: string }>(`/chat/sessions/${id}`, { method: "DELETE" });
	notifySessionsChanged("deleted");
	return result;
}

export function abortSession(id: string): Promise<void> {
	return fetch(`/chat/sessions/${id}/abort`, {
		method: "POST",
		credentials: "include",
	}).then(() => undefined);
}

export function sendMessage(
	sessionId: string,
	text: string,
	tabId: string,
	attachmentIds?: string[],
): ReadableStream<Uint8Array> {
	const controller = new AbortController();
	const stream = new ReadableStream<Uint8Array>({
		async start(streamController) {
			try {
				const body: Record<string, unknown> = { session_id: sessionId, text, tab_id: tabId };
				if (attachmentIds && attachmentIds.length > 0) {
					body.attachment_ids = attachmentIds;
				}
				const res = await fetch("/chat/stream", {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				if (!res.ok || !res.body) {
					streamController.close();
					return;
				}
				const reader = res.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					streamController.enqueue(value);
				}
			} catch {
				// aborted or network error
			} finally {
				streamController.close();
			}
		},
		cancel() {
			controller.abort();
		},
	});
	return stream;
}

export function resumeSession(sessionId: string, lastSeq: number): ReadableStream<Uint8Array> {
	const controller = new AbortController();
	const stream = new ReadableStream<Uint8Array>({
		async start(streamController) {
			try {
				const res = await fetch(`/chat/sessions/${sessionId}/resume`, {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ client_last_seq: lastSeq }),
					signal: controller.signal,
				});
				if (!res.ok || !res.body) {
					streamController.close();
					return;
				}
				const reader = res.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					streamController.enqueue(value);
				}
			} catch {
				// aborted or network error
			} finally {
				streamController.close();
			}
		},
		cancel() {
			controller.abort();
		},
	});
	return stream;
}
