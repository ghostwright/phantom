import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { publish } from "./events.ts";
import { getPublicDir } from "./serve.ts";
import { createSession } from "./session.ts";

function ok(data: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

export function createWebUiToolServer(publicUrl: string | undefined): McpSdkServerConfigWithInstance {
	const baseUrl = publicUrl ?? "";

	const createPageTool = tool(
		"phantom_create_page",
		"Create or update an HTML page served at /ui/<path>. If html is provided, writes it directly. " +
			"If title and content are provided instead, wraps the content in the base template. " +
			"Returns the public URL of the page.",
		{
			path: z.string().min(1).describe("File path relative to public/, e.g. 'dashboard.html' or 'reports/weekly.html'"),
			html: z.string().optional().describe("Full HTML content to write (use this for complete pages)"),
			title: z.string().optional().describe("Page title (used when wrapping content in base template)"),
			content: z.string().optional().describe("HTML content for the <main> section (wrapped in base template)"),
		},
		async (input) => {
			try {
				if (!input.html && !input.content) {
					return err("Provide either 'html' (full page) or 'content' (to wrap in base template)");
				}

				// Sanitize path - no traversal
				const safePath = input.path.replace(/\.\./g, "").replace(/^\/+/, "");
				if (!safePath || safePath.includes("\0")) {
					return err("Invalid path");
				}

				const fullPath = resolve(getPublicDir(), safePath);
				const publicRoot = getPublicDir();
				if (!fullPath.startsWith(publicRoot)) {
					return err("Path escapes public directory");
				}

				let htmlContent: string;
				if (input.html) {
					htmlContent = input.html;
				} else {
					htmlContent = wrapInBaseTemplate(input.title ?? "Phantom", input.content ?? "");
				}

				// Ensure parent directory exists
				const dir = dirname(fullPath);
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}

				await Bun.write(fullPath, htmlContent);

				// Notify SSE clients that a page was updated
				publish("page_updated", { path: `/ui/${safePath}` });

				const publicUrl = baseUrl ? `${baseUrl}/ui/${safePath}` : `/ui/${safePath}`;
				return ok({
					created: true,
					path: safePath,
					url: publicUrl,
					size: htmlContent.length,
				});
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	const generateLoginTool = tool(
		"phantom_generate_login",
		"Generate a magic link for web UI authentication. Send this link to the user via Slack. " +
			"The link expires in 10 minutes. After authentication, the session lasts 7 days.",
		{},
		async () => {
			try {
				const { magicToken } = createSession();
				const loginUrl = baseUrl ? `${baseUrl}/ui/login?magic=${magicToken}` : `/ui/login?magic=${magicToken}`;

				return ok({
					magicLink: loginUrl,
					// sessionToken intentionally excluded - agent should only share the magic link
					expiresIn: "10 minutes",
					sessionDuration: "7 days",
					note: "Send the magic link to the user via Slack. They click it and are authenticated instantly.",
				});
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-web-ui",
		tools: [createPageTool, generateLoginTool],
	});
}

function wrapInBaseTemplate(title: string, content: string): string {
	const now = new Date();
	const date = now.toISOString().split("T")[0];
	const timestamp = now.toISOString();

	// Read base template and substitute placeholders
	const baseTemplatePath = resolve(getPublicDir(), "_base.html");
	let template: string;
	try {
		template = readFileSync(baseTemplatePath, "utf-8");
	} catch {
		// Fallback: generate a minimal template if _base.html is missing
		return generateFallbackPage(title, content, date, timestamp);
	}

	return template
		.replace(/\{\{TITLE\}\}/g, escapeHtml(title))
		.replace(/\{\{DATE\}\}/g, date)
		.replace(/\{\{TIMESTAMP\}\}/g, timestamp)
		.replace("<!-- Agent writes content here -->", content);
}

function generateFallbackPage(title: string, content: string, date: string, timestamp: string): string {
	return `<!DOCTYPE html>
<html lang="en" data-theme="phantom-light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Phantom</title>
  <script>
    (function() {
      var s = localStorage.getItem('phantom-theme');
      var d = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', s || (d ? 'phantom-dark' : 'phantom-light'));
    })();
  <\/script>
  <link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
  <style type="text/tailwindcss">
    @theme {
      --color-phantom: #0891b2;
      --font-family-sans: 'Inter', system-ui, sans-serif;
    }
    [data-theme="phantom-light"] {
      --color-base-100: #fafaf9;
      --color-base-200: #ffffff;
      --color-base-300: #e7e5e4;
      --color-base-content: #1c1917;
      --color-primary: #0891b2;
      --color-primary-content: #ffffff;
      color-scheme: light;
    }
    [data-theme="phantom-dark"] {
      --color-base-100: #0c0a09;
      --color-base-200: #1c1917;
      --color-base-300: #292524;
      --color-base-content: #fafaf9;
      --color-primary: #22d3ee;
      --color-primary-content: #0c0a09;
      color-scheme: dark;
    }
  </style>
</head>
<body class="bg-base-100 text-base-content font-sans min-h-screen">
  <nav class="navbar bg-base-200/90 border-b border-base-300 px-6 sticky top-0 z-50 backdrop-blur-md">
    <div class="navbar-start gap-3">
      <div class="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-primary-content text-xs font-bold">P</div>
      <span class="font-semibold text-base">Phantom</span>
      <span class="text-base-content/20">/</span>
      <span class="text-sm text-base-content/60">${escapeHtml(title)}</span>
    </div>
    <div class="navbar-end"><span class="text-xs text-base-content/40 font-mono">${date}</span></div>
  </nav>
  <main class="max-w-7xl mx-auto px-6 py-8">${content}</main>
  <footer class="border-t border-base-300 mt-16">
    <div class="max-w-7xl mx-auto px-6 py-5 flex justify-between text-xs text-base-content/40">
      <span>Generated by Phantom</span><span>${timestamp}</span>
    </div>
  </footer>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
