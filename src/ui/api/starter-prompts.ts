// GET /ui/api/starter-prompts - public endpoint that powers the landing page
// "What can <name> do?" section.
//
// Public by design: the tiles render before the operator authenticates so the
// first-visit hero is not empty. Content is operator-controlled copy, not
// sensitive state. See src/ui/starter-prompts.ts for the defaults + YAML
// loader and the Cardinal Rule note.

import { resolve } from "node:path";
import { loadStarterPrompts } from "../starter-prompts.ts";

let configDirOverride: string | null = null;

export function setStarterPromptsConfigDirForTests(dir: string | null): void {
	configDirOverride = dir;
}

function getConfigDir(): string {
	return configDirOverride ?? resolve(process.cwd(), "phantom-config");
}

export function handleStarterPromptsApi(req: Request): Response {
	if (req.method !== "GET") {
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET" },
		});
	}

	const tiles = loadStarterPrompts(getConfigDir());
	return new Response(JSON.stringify({ tiles }), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "private, max-age=60",
		},
	});
}
