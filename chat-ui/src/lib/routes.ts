export const CHAT_ROOT_PATH = "/chat";

export function chatSessionPath(sessionId: string): string {
	return `${CHAT_ROOT_PATH}/s/${encodeURIComponent(sessionId)}`;
}

export function legacyChatSessionPath(sessionId: string): string {
	return `/s/${encodeURIComponent(sessionId)}`;
}
