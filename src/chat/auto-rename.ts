import { z } from "zod/v4";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { ChatSessionStore } from "./session-store.ts";

const titleSchema = z.object({
	title: z.string(),
});

export async function autoRenameSession(
	runtime: AgentRuntime,
	sessionStore: ChatSessionStore,
	sessionId: string,
	userMessage: string,
	assistantMessage: string,
): Promise<void> {
	try {
		const result = await runtime.judgeQuery({
			systemPrompt: 'Generate a concise 3-5 word title for this conversation. Return JSON: {"title": "..."}.',
			userMessage: `User: ${userMessage}\n\nAssistant: ${assistantMessage}`,
			schema: titleSchema,
			omitPreset: true,
		});

		if (result.data.title) {
			sessionStore.setAutoTitle(sessionId, result.data.title);
			console.log(`[chat] Auto-renamed session ${sessionId}: "${result.data.title}"`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[chat] Auto-rename failed for session ${sessionId}: ${msg}`);
	}
}
