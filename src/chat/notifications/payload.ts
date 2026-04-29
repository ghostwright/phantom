// Notification payload factories. Each returns a structured payload
// under 3 KB cleartext for the push service.

export type NotificationPayload = {
	title: string;
	body: string;
	tag: string;
	data: {
		url: string;
		type: string;
		sessionId?: string;
	};
};

const MAX_PAYLOAD_BYTES = 3072; // 3 KB - safe across push services
const encoder = new TextEncoder();

function byteLength(str: string): number {
	return encoder.encode(str).length;
}

function truncateToByteLimit(text: string, maxBytes: number): string {
	const encoded = encoder.encode(text);
	if (encoded.length <= maxBytes) return text;
	const decoder = new TextDecoder();
	return `${decoder.decode(encoded.slice(0, maxBytes - 3))}...`;
}

function ensurePayloadFits(payload: NotificationPayload): NotificationPayload {
	const json = JSON.stringify(payload);
	if (byteLength(json) <= MAX_PAYLOAD_BYTES) return payload;
	// Truncate body to bring payload under limit
	const overhead = byteLength(json) - byteLength(payload.body);
	const maxBodyBytes = MAX_PAYLOAD_BYTES - overhead - 10;
	return { ...payload, body: truncateToByteLimit(payload.body, maxBodyBytes) };
}

export function sessionCompletePayload(sessionId: string, title: string, durationMs: number): NotificationPayload {
	const durationSec = Math.round(durationMs / 1000);
	const durationLabel = durationSec >= 60 ? `${Math.round(durationSec / 60)}m` : `${durationSec}s`;
	const body = title ? `${title} (${durationLabel})` : `Task finished in ${durationLabel}`;

	return ensurePayloadFits({
		title: "Task complete",
		body,
		tag: `session-complete-${sessionId}`,
		data: {
			url: `/chat/s/${sessionId}`,
			type: "session_complete",
			sessionId,
		},
	});
}

export function agentMessagePayload(sessionId: string, preview: string): NotificationPayload {
	const truncated = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
	return ensurePayloadFits({
		title: "New message",
		body: truncated,
		tag: `agent-message-${sessionId}`,
		data: {
			url: `/chat/s/${sessionId}`,
			type: "agent_message",
			sessionId,
		},
	});
}

export function scheduledJobPayload(jobName: string, status: string): NotificationPayload {
	return ensurePayloadFits({
		title: `Scheduled: ${jobName}`,
		body: status,
		tag: `scheduled-${jobName}`,
		data: {
			url: "/chat/",
			type: "scheduled_result",
		},
	});
}

export function hardErrorPayload(sessionId: string, error: string): NotificationPayload {
	const truncated = error.length > 120 ? `${error.slice(0, 117)}...` : error;
	return ensurePayloadFits({
		title: "Error",
		body: truncated,
		tag: `error-${sessionId}`,
		data: {
			url: `/chat/s/${sessionId}`,
			type: "hard_error",
			sessionId,
		},
	});
}

export function testPayload(agentName?: string): NotificationPayload {
	// Title clearly labels this as a test so users do not mistake the
	// notification for a real message. Without "test" in the title the
	// notification read "Cheema: Push notifications are working" which
	// looked like a real agent message at a glance.
	return {
		title: agentName && agentName.length > 0 ? `${agentName} test` : "Test notification",
		body: "Push notifications are working",
		tag: "test-notification",
		data: {
			url: "/chat/",
			type: "test",
		},
	};
}
