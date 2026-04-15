// Session-specific and streaming route handlers for the chat HTTP API.
// Split from http.ts to keep both files under 300 lines.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type MessageParam = SDKUserMessage["message"];
import type { ChatHandlerDeps } from "./http.ts";
import { buildUserMessageParam } from "./message-builder.ts";
import { readAttachmentFile } from "./storage.ts";
import type { StreamBus } from "./stream-bus.ts";
import type { ChatWireFrame } from "./types.ts";
import { ChatSessionWriter, getActiveWriter } from "./writer.ts";

export function handleGetSession(sessionId: string, deps: ChatHandlerDeps): Response {
	const session = deps.sessionStore.get(sessionId);
	if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
	const messages = deps.messageStore.getBySession(sessionId);
	return Response.json({ ...session, messages });
}

export async function handleUpdateSession(req: Request, sessionId: string, deps: ChatHandlerDeps): Promise<Response> {
	let body: { title?: string; pinned?: boolean; status?: string } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const validStatuses = new Set(["active", "archived", "deleted"]);
	if (body.status !== undefined && !validStatuses.has(body.status)) {
		return Response.json({ error: "Invalid status" }, { status: 400 });
	}
	deps.sessionStore.update(sessionId, {
		title: body.title,
		pinned: body.pinned,
		status: body.status as "active" | "archived" | "deleted" | undefined,
	});
	return Response.json({ ok: true });
}

export function handleDeleteSession(sessionId: string, deps: ChatHandlerDeps): Response {
	const undoUntil = deps.sessionStore.softDelete(sessionId);
	return Response.json({ ok: true, undo_until: undoUntil });
}

export async function handleForkSession(req: Request, sessionId: string, deps: ChatHandlerDeps): Promise<Response> {
	let body: { from_message_seq?: number } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const fromSeq = body.from_message_seq ?? 0;
	const forked = deps.sessionStore.fork(sessionId, fromSeq);
	return Response.json({ id: forked.id, forked_from_session_id: sessionId }, { status: 201 });
}

export async function handleStream(req: Request, deps: ChatHandlerDeps): Promise<Response> {
	let body: { session_id?: string; text?: string; tab_id?: string; attachment_ids?: string[] } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (!body.session_id || !body.text) {
		return Response.json({ error: "session_id and text are required" }, { status: 400 });
	}

	const existingWriter = getActiveWriter(body.session_id);
	if (existingWriter?.isActive) {
		return Response.json({ error: "Session busy" }, { status: 409 });
	}

	const session = deps.sessionStore.get(body.session_id);
	if (!session) {
		return Response.json({ error: "Session not found" }, { status: 404 });
	}

	const tabId = body.tab_id ?? "default";
	const attachmentIds = body.attachment_ids ?? [];
	let message: MessageParam;
	if (attachmentIds.length > 0) {
		message = await buildUserMessageParam(body.text, attachmentIds, deps.attachmentStore);
	} else {
		message = { role: "user", content: body.text };
	}

	const writer = new ChatSessionWriter({
		sessionId: body.session_id,
		runtime: deps.runtime,
		eventLog: deps.eventLog,
		messageStore: deps.messageStore,
		sessionStore: deps.sessionStore,
		streamBus: deps.streamBus,
		notificationTriggers: deps.notificationTriggers,
	});
	writer.claim();

	const sessionId = body.session_id;
	const stream = createSSEStream(sessionId, deps.streamBus, writer);

	writer.run(message, tabId, body.text).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[chat-http] Writer error for session ${sessionId}: ${msg}`);
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Phantom-Chat-Wire-Version": "1",
		},
	});
}

export async function handleResume(req: Request, sessionId: string, deps: ChatHandlerDeps): Promise<Response> {
	let body: { client_last_seq?: number; tab_id?: string } = {};
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const clientLastSeq = body.client_last_seq ?? 0;

	let resumeUnsub: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const write = (text: string): void => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					/* closed */
				}
			};

			write("retry: 5000\n\n");

			const writerActive = getActiveWriter(sessionId)?.isActive ?? false;

			const resumedFrame: ChatWireFrame = {
				event: "session.resumed",
				session_id: sessionId,
				resumed_from_seq: clientLastSeq,
				writer_active: writerActive,
			};
			write(formatSSE(resumedFrame, clientLastSeq + 1));

			const events = deps.eventLog.drain(sessionId, clientLastSeq);
			for (const evt of events) {
				write(`id: ${evt.seq}\nevent: ${evt.event_type}\ndata: ${evt.payload_json}\n\n`);
			}

			const maxSeq = deps.eventLog.getMaxSeq(sessionId);
			const caughtUpFrame: ChatWireFrame = {
				event: "session.caught_up",
				session_id: sessionId,
				up_to_seq: maxSeq,
			};
			write(formatSSE(caughtUpFrame, maxSeq + 1));

			if (writerActive) {
				resumeUnsub = deps.streamBus.subscribe(sessionId, (frame, seq) => {
					write(formatSSE(frame, seq));
					if (frame.event === "session.done" || frame.event === "session.error") {
						resumeUnsub?.();
						resumeUnsub = null;
						controller.close();
					}
				});
			} else {
				controller.close();
			}
		},
		cancel() {
			resumeUnsub?.();
			resumeUnsub = null;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Phantom-Chat-Wire-Version": "1",
		},
	});
}

export function handleAbort(sessionId: string): Response {
	const writer = getActiveWriter(sessionId);
	if (writer?.isActive) writer.abort();
	return new Response(null, { status: 204 });
}

export function formatSSE(frame: ChatWireFrame, seq: number): string {
	return `id: ${seq}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`;
}

export async function handleAttachmentPreview(attachmentId: string, deps: ChatHandlerDeps): Promise<Response> {
	const att = deps.attachmentStore.getById(attachmentId);
	if (!att) return Response.json({ error: "Attachment not found" }, { status: 404 });

	try {
		const data = await readAttachmentFile(att.storage_path);
		const sanitized = (att.filename ?? "file").replace(/["\n\r]/g, "_");
		const isImage = att.mime_type?.startsWith("image/");
		const disposition = isImage ? `inline; filename="${sanitized}"` : `attachment; filename="${sanitized}"`;

		return new Response(new Uint8Array(data), {
			headers: {
				"Content-Type": att.mime_type ?? "application/octet-stream",
				"Content-Length": String(data.byteLength),
				"Content-Disposition": disposition,
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox",
				"Cache-Control": "private, max-age=3600",
			},
		});
	} catch {
		return Response.json({ error: "File not found" }, { status: 404 });
	}
}

function createSSEStream(sessionId: string, streamBus: StreamBus, writer: ChatSessionWriter): ReadableStream {
	let unsub: (() => void) | null = null;
	let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

	return new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const write = (text: string): void => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					/* closed */
				}
			};

			write("retry: 5000\n\n");

			unsub = streamBus.subscribe(sessionId, (frame, seq) => {
				write(formatSSE(frame, seq));
				if (frame.event === "session.done" || frame.event === "session.error") {
					unsub?.();
					unsub = null;
					if (keepAliveTimer) clearInterval(keepAliveTimer);
					keepAliveTimer = null;
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				}
			});

			keepAliveTimer = setInterval(() => {
				if (!writer.isActive) {
					if (keepAliveTimer) clearInterval(keepAliveTimer);
					keepAliveTimer = null;
					return;
				}
				write(":ka\n\n");
			}, 25000);
		},
		cancel() {
			unsub?.();
			unsub = null;
			if (keepAliveTimer) clearInterval(keepAliveTimer);
			keepAliveTimer = null;
		},
	});
}
