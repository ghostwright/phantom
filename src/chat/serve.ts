import { relative, resolve } from "node:path";
import { getPublicDir } from "../ui/serve.ts";

// Serve static files from public/chat/ with SPA fallback.
// Chat historically navigates session routes at /s/:id while the app assets
// live under /chat/. Both URL shapes should refresh into the same SPA.

function getChatDir(): string {
	return resolve(getPublicDir(), "chat");
}

function isPathSafe(urlPath: string, chatDir: string): string | null {
	try {
		const decoded = decodeURIComponent(urlPath);
		if (decoded.includes("\0")) return null;

		const cleaned = decoded.replace(/^\/chat\/?/, "/");
		const target = resolve(chatDir, cleaned.replace(/^\/+/, ""));
		const rel = relative(chatDir, target);

		if (rel.startsWith("..") || rel.includes("..")) return null;
		return target;
	} catch {
		return null;
	}
}

function isChatStaticPath(pathname: string): boolean {
	return pathname.startsWith("/chat") || pathname === "/s" || pathname.startsWith("/s/") || pathname === "/new";
}

export async function handleChatStaticRequest(req: Request): Promise<Response | null> {
	const url = new URL(req.url);
	if (!isChatStaticPath(url.pathname)) return null;

	const chatDir = getChatDir();
	const filePath = isPathSafe(url.pathname, chatDir);
	if (!filePath) return new Response("Forbidden", { status: 403 });

	const file = Bun.file(filePath);
	if (await file.exists()) {
		const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
		const cacheControl = ext === "html" ? "no-cache" : "public, max-age=31536000, immutable";
		return new Response(file, {
			headers: { "Cache-Control": cacheControl },
		});
	}

	// SPA fallback: serve index.html for non-file paths
	const indexPath = resolve(chatDir, "index.html");
	const indexFile = Bun.file(indexPath);
	if (await indexFile.exists()) {
		return new Response(indexFile, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-cache",
			},
		});
	}

	// chat-ui not built yet (PR1 has no client)
	return null;
}
