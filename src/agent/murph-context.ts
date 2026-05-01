export type MurphContextTransform = (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]> | unknown[];

const PHANTOM_CONTEXT_OPEN_TAG = "<phantom_chat_context>";
const PHANTOM_CONTEXT_CLOSE_TAG = "</phantom_chat_context>";

type PhantomContextMessage = {
	role: "user";
	content: [{ type: "text"; text: string }];
	timestamp: number;
};

export function createMurphContextTransform(context: string | undefined): MurphContextTransform | undefined {
	const trimmed = context?.trim();
	if (!trimmed) return undefined;

	return (messages: unknown[]) => {
		const cleaned = messages.filter((message) => !isPhantomContextMessage(message));
		const contextMessage = buildContextMessage(trimmed);
		if (cleaned.length === 0) {
			return [contextMessage];
		}

		const lastIndex = cleaned.length - 1;
		const lastMessage = cleaned[lastIndex];
		if (hasRole(lastMessage, "user")) {
			return [...cleaned.slice(0, lastIndex), contextMessage, lastMessage];
		}

		return [...cleaned, contextMessage];
	};
}

function buildContextMessage(content: string): PhantomContextMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					PHANTOM_CONTEXT_OPEN_TAG,
					"Durable context supplied by Phantom outside the raw transcript.",
					"Use it to continue after Murph compaction without asking the user to repeat known app state.",
					content,
					PHANTOM_CONTEXT_CLOSE_TAG,
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};
}

function isPhantomContextMessage(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "user") return false;
	const content = message.content;
	if (typeof content === "string") return content.includes(PHANTOM_CONTEXT_OPEN_TAG);
	if (!Array.isArray(content)) return false;
	return content.some(
		(item) => isRecord(item) && item.type === "text" && textField(item).includes(PHANTOM_CONTEXT_OPEN_TAG),
	);
}

function hasRole(message: unknown, role: string): boolean {
	return isRecord(message) && message.role === role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function textField(record: Record<string, unknown>): string {
	return typeof record.text === "string" ? record.text : "";
}
