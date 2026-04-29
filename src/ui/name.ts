// WHY: agent name customization. The PHANTOM_NAME env var lets operators run
// "cheeks", "wehshi", "ai-coworker" etc. as the deployed agent identity.
// This helper normalizes that name into a stable display form for the navbar
// brand, page titles, and login surfaces. Empty input falls back to "Phantom"
// so the brand never reads as blank if the env var is unset.

export function capitalizeAgentName(name: string): string {
	if (!name) return "Phantom";
	const trimmed = name.trim();
	if (trimmed.length === 0) return "Phantom";
	return trimmed
		.split(/([-_])/)
		.map((part) => {
			if (part === "-" || part === "_") return part;
			if (part.length === 0) return part;
			return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
		})
		.join("");
}

export function agentNameInitial(displayName: string): string {
	if (!displayName) return "P";
	const ch = displayName.charAt(0);
	return ch ? ch.toUpperCase() : "P";
}
