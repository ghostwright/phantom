import type { SDKUserMessage } from "../agent/agent-sdk.ts";

type MessageParam = SDKUserMessage["message"];
import type { ChatHandlerDeps } from "./http.ts";
import { type BuiltUserMessage, ChatAttachmentResolutionError, buildUserMessage } from "./message-builder.ts";
import {
	CHAT_SSE_HEADERS,
	CHAT_SSE_RETRY_MS,
	closeSseController,
	createServerRestartRecoveryFrame,
	createSseCloseScheduler,
	formatSSE,
	isTerminalChatEvent,
	startSseHeartbeat,
} from "./sse.ts";
import { readAttachmentFile } from "./storage.ts";
import { createSSEStream } from "./stream-sse.ts";
import type { ChatWireFrame } from "./types.ts";
import { ChatSessionWriter, getActiveWriter } from "./writer.ts";

export function handleGetSession(sessionId: string, deps: ChatHandlerDeps): Response {
	const session = deps.sessionStore.get(sessionId);
	if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
	const messages = deps.messageStore.getBySession(sessionId);
	const writerActive = getActiveWriter(sessionId)?.isActive ?? false;
	const streamState = deps.eventLog.getStreamState(sessionId, writerActive);
	const runTimelines = deps.timelineStore?.getDetailsBySession(sessionId) ?? [];
	return Response.json({
		...session,
		messages,
		stream_state: {
			max_seq: streamState.maxSeq,
			latest_terminal_seq: streamState.latestTerminalSeq,
			writer_active: streamState.writerActive,
			has_incomplete_tail: streamState.hasIncompleteTail,
		},
		run_timelines: runTimelines,
	});
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
	if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
	const tabId = body.tab_id ?? "default";
	const attachmentIds = body.attachment_ids ?? [];
	let message: MessageParam = { role: "user", content: body.text };
	let writerOptions: Pick<BuiltUserMessage, "attachments" | "transcriptContent"> | undefined;
	if (attachmentIds.length > 0) {
		try {
			const builtMessage = await buildUserMessage(body.text, attachmentIds, body.session_id, deps.attachmentStore);
			message = builtMessage.message;
			writerOptions = { attachments: builtMessage.attachments, transcriptContent: builtMessage.transcriptContent };
		} catch (err: unknown) {
			if (err instanceof ChatAttachmentResolutionError) {
				return Response.json({ error: err.code, message: err.message }, { status: 400 });
			}
			const messageText = err instanceof Error ? err.message : String(err);
			console.error(`[chat-http] Attachment build failed for session ${body.session_id}: ${messageText}`);
			return Response.json(
				{ error: "attachment_read_failed", message: "Could not read one or more attachments." },
				{ status: 500 },
			);
		}
	}

	const writer = new ChatSessionWriter({
		sessionId: body.session_id,
		runtime: deps.runtime,
		eventLog: deps.eventLog,
		messageStore: deps.messageStore,
		attachmentStore: deps.attachmentStore,
		sessionStore: deps.sessionStore,
		timelineStore: deps.timelineStore,
		streamBus: deps.streamBus,
		notificationTriggers: deps.notificationTriggers,
	});
	writer.claim();

	const sessionId = body.session_id;
	const stream = createSSEStream(sessionId, deps.streamBus, writer);

	writer.run(message, tabId, body.text, writerOptions).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[chat-http] Writer error for session ${sessionId}: ${msg}`);
	});

	return new Response(stream, { headers: CHAT_SSE_HEADERS });
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
	let resumeHeartbeatCleanup: (() => void) | null = null;
	const cleanupResumeStream = (): void => {
		resumeUnsub?.();
		resumeUnsub = null;
		resumeHeartbeatCleanup?.();
		resumeHeartbeatCleanup = null;
	};

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

			const close = (): void => {
				cleanupResumeStream();
				closeSseController(controller);
			};
			const closeSoon = createSseCloseScheduler(() => {
				resumeHeartbeatCleanup?.();
				resumeHeartbeatCleanup = null;
			}, close);

			write(`retry: ${CHAT_SSE_RETRY_MS}\n\n`);

			const writerActive = getActiveWriter(sessionId)?.isActive ?? false;
			const liveReplayBuffer: Array<{ frame: ChatWireFrame; seq: number }> = [];
			let replaying = true;
			let replayAfterSeq = clientLastSeq;
			let terminalSeenDuringReplay = false;

			if (writerActive) {
				resumeUnsub = deps.streamBus.subscribe(sessionId, (frame, seq) => {
					if (replaying) {
						liveReplayBuffer.push({ frame, seq });
						return;
					}
					if (seq <= replayAfterSeq) return;
					write(formatSSE(frame, seq));
					replayAfterSeq = seq;
					if (isTerminalChatEvent(frame.event)) {
						closeSoon();
					}
				});
			}

			const resumedFrame: ChatWireFrame = {
				event: "session.resumed",
				session_id: sessionId,
				resumed_from_seq: clientLastSeq,
				writer_active: writerActive,
			};
			write(formatSSE(resumedFrame));

			while (true) {
				const events = deps.eventLog.drain(sessionId, replayAfterSeq);
				if (events.length === 0) break;
				for (const evt of events) {
					write(`id: ${evt.seq}\nevent: ${evt.event_type}\ndata: ${evt.payload_json}\n\n`);
					replayAfterSeq = evt.seq;
					if (isTerminalChatEvent(evt.event_type)) {
						terminalSeenDuringReplay = true;
					}
				}
			}

			if (writerActive) {
				liveReplayBuffer.sort((left, right) => left.seq - right.seq);
				for (const buffered of liveReplayBuffer) {
					if (buffered.seq <= replayAfterSeq) continue;
					write(formatSSE(buffered.frame, buffered.seq));
					replayAfterSeq = buffered.seq;
					if (isTerminalChatEvent(buffered.frame.event)) {
						terminalSeenDuringReplay = true;
					}
				}
			}
			replaying = false;

			const maxSeq = writerActive ? replayAfterSeq : deps.eventLog.getMaxSeq(sessionId);
			const caughtUpFrame: ChatWireFrame = {
				event: "session.caught_up",
				session_id: sessionId,
				up_to_seq: maxSeq,
			};
			write(formatSSE(caughtUpFrame));

			if (writerActive) {
				const writerStillActive = getActiveWriter(sessionId)?.isActive ?? false;
				if (terminalSeenDuringReplay) {
					closeSoon();
				} else if (!writerStillActive) {
					write(formatSSE(createServerRestartRecoveryFrame(sessionId)));
					closeSoon();
				} else {
					resumeHeartbeatCleanup = startSseHeartbeat(write, () => getActiveWriter(sessionId)?.isActive ?? false, {
						onStop: closeSoon,
					});
				}
			} else {
				const streamState = deps.eventLog.getStreamState(sessionId, false);
				if (streamState.hasIncompleteTail) {
					write(formatSSE(createServerRestartRecoveryFrame(sessionId)));
				}
				controller.close();
			}
		},
		cancel() {
			cleanupResumeStream();
		},
	});

	return new Response(stream, { headers: CHAT_SSE_HEADERS });
}

export function handleAbort(sessionId: string): Response {
	const writer = getActiveWriter(sessionId);
	if (writer?.isActive) writer.abort();
	return new Response(null, { status: 204 });
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
