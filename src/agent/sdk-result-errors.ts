type SdkResultLike = {
	type?: unknown;
	subtype?: unknown;
	errors?: unknown;
};

export function sdkResultErrorText(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const result = message as SdkResultLike;
	if (result.type !== "result" || result.subtype === "success") return null;
	if (!Array.isArray(result.errors)) return null;
	const errors = result.errors.filter((error): error is string => typeof error === "string");
	return errors.length > 0 ? errors.join("\n") : null;
}

export function isNoConversationFoundResult(message: unknown): boolean {
	return sdkResultErrorText(message)?.includes("No conversation found") ?? false;
}
