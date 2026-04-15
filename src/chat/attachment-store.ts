import type { Database } from "bun:sqlite";

export type ChatAttachment = {
	id: string;
	session_id: string | null;
	message_id: string | null;
	kind: string;
	filename: string | null;
	mime_type: string | null;
	size_bytes: number | null;
	storage_path: string;
	sha256: string | null;
	uploaded_at: string;
	committed_at: string | null;
};

export type ChatAttachmentCreateParams = {
	id?: string;
	sessionId?: string;
	kind: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	storagePath: string;
	sha256?: string;
};

export class ChatAttachmentStore {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	create(params: ChatAttachmentCreateParams): string {
		const id = params.id ?? crypto.randomUUID();
		this.db.run(
			`INSERT INTO chat_attachments (id, session_id, kind, filename, mime_type, size_bytes, storage_path, sha256)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				params.sessionId ?? null,
				params.kind,
				params.filename,
				params.mimeType,
				params.sizeBytes,
				params.storagePath,
				params.sha256 ?? null,
			],
		);
		return id;
	}

	commitToMessage(attachmentId: string, messageId: string): void {
		this.db.run(
			`UPDATE chat_attachments SET message_id = ?, committed_at = datetime('now')
			 WHERE id = ?`,
			[messageId, attachmentId],
		);
	}

	getById(id: string): ChatAttachment | null {
		return this.db.query("SELECT * FROM chat_attachments WHERE id = ?").get(id) as ChatAttachment | null;
	}

	getBySession(sessionId: string): ChatAttachment[] {
		return this.db
			.query("SELECT * FROM chat_attachments WHERE session_id = ? ORDER BY uploaded_at ASC")
			.all(sessionId) as ChatAttachment[];
	}

	getOrphans(olderThanHours: number): ChatAttachment[] {
		return this.db
			.query(
				`SELECT * FROM chat_attachments
				 WHERE committed_at IS NULL
				 AND uploaded_at < datetime('now', ?)`,
			)
			.all(`-${olderThanHours} hours`) as ChatAttachment[];
	}

	deleteById(id: string): void {
		this.db.run("DELETE FROM chat_attachments WHERE id = ?", [id]);
	}
}
