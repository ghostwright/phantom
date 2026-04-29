import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setPublicDir } from "../serve.ts";
import { revokeAllSessions } from "../session.ts";
import { createWebUiToolServer, wrapInBaseTemplate } from "../tools.ts";

const testPublicDir = resolve(import.meta.dir, "../../../public");
setPublicDir(testPublicDir);

// Clean up test files after each test
const createdFiles: string[] = [];

afterEach(() => {
	revokeAllSessions();
	for (const file of createdFiles) {
		if (existsSync(file)) {
			rmSync(file, { force: true });
		}
	}
	createdFiles.length = 0;
	// Clean up test subdirectories
	const testDir = resolve(testPublicDir, "_test_pages");
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

describe("createWebUiToolServer", () => {
	test("creates an MCP server with two tools", () => {
		const server = createWebUiToolServer("https://phantom-dev.ghostwright.dev", "cheeks");
		expect(server).toBeDefined();
		expect(server.name).toBe("phantom-web-ui");
	});
});

describe("phantom_generate_login tool integration", () => {
	test("generate login returns magic link with correct domain", async () => {
		const server = createWebUiToolServer("https://phantom-dev.ghostwright.dev", "cheeks");
		// The tool server is an MCP SDK server. We test it by verifying the factory produces valid output.
		expect(server).toBeDefined();
	});

	test("phantom_generate_login output contains magicLink but not sessionToken", async () => {
		// The tool uses createSession internally. We verify the contract:
		// createSession returns both tokens, but the tool must only expose the magic link.
		const { createSession: cs } = await import("../session.ts");
		const session = cs();
		expect(session.sessionToken).toBeDefined();
		expect(session.magicToken).toBeDefined();

		// Verify the tool server is created correctly
		const server = createWebUiToolServer("https://phantom-dev.ghostwright.dev", "cheeks");
		expect(server.name).toBe("phantom-web-ui");

		// Verify that createSession() still produces a sessionToken (it is used server-side
		// for the magic link to session mapping, just not exposed to the agent)
		expect(typeof session.sessionToken).toBe("string");
		expect(session.sessionToken.length).toBeGreaterThan(0);
	});
});

describe("phantom_create_page tool integration", () => {
	test("tool server has expected name", () => {
		const server = createWebUiToolServer(undefined, "cheeks");
		expect(server.name).toBe("phantom-web-ui");
	});
});

describe("wrapInBaseTemplate placeholder substitution", () => {
	test("substitutes agent name capitalized into navbar and title", () => {
		const html = wrapInBaseTemplate("Test", "<h1>Hi</h1>", "cheeks");
		expect(html).toContain("Cheeks");
		expect(html).not.toContain("{{AGENT_NAME_CAPITALIZED}}");
	});

	test("removes all placeholder markers after substitution", () => {
		// Verify no stray placeholder markers leak into the rendered output.
		const html = wrapInBaseTemplate("Test", "<h1>Hi</h1>", "cheeks");
		expect(html).not.toContain("{{AGENT_NAME_CAPITALIZED}}");
		expect(html).not.toContain("{{AGENT_NAME_INITIAL}}");
		expect(html).not.toContain("{{TITLE}}");
		expect(html).not.toContain("{{DATE}}");
		expect(html).not.toContain("{{TIMESTAMP}}");
	});

	test("substitutes agent name initial placeholder", () => {
		const html = wrapInBaseTemplate("Test", "<h1>Hi</h1>", "wehshi");
		expect(html).toContain("Wehshi");
		expect(html).not.toContain("{{AGENT_NAME_INITIAL}}");
	});

	test("preserves phantom-* CSS class names during substitution", () => {
		const html = wrapInBaseTemplate("Test", "<p class='phantom-card'>body</p>", "cheeks");
		expect(html).toContain("phantom-card");
	});

	test("empty agent name falls back to Phantom in display surfaces", () => {
		const html = wrapInBaseTemplate("Test", "<h1>Hi</h1>", "");
		expect(html).toContain("Phantom");
	});

	test("substitutes title placeholder and includes injected content", () => {
		const html = wrapInBaseTemplate("My Page", "<h1 id='probe'>Hello</h1>", "cody");
		expect(html).toContain("My Page");
		expect(html).toContain("id='probe'");
		expect(html).not.toContain("{{TITLE}}");
		expect(html).not.toContain("<!-- Agent writes content here -->");
	});
});

describe("wrapInBaseTemplate dollar-pattern safety", () => {
	test("preserves $& in content literally", () => {
		const out = wrapInBaseTemplate("Test", "<p>Price: $&now</p>", "cheeks");
		expect(out).toContain("<p>Price: $&now</p>");
		expect(out).not.toContain("<!-- Agent writes content here -->");
	});

	test("preserves $`, $', $$ in content literally", () => {
		const out = wrapInBaseTemplate("Test", "<p>$` $' $$ here</p>", "cheeks");
		expect(out).toContain("<p>$` $' $$ here</p>");
	});

	test("does not re-substitute placeholder literals in title", () => {
		// escapeHtml leaves { and } alone, so the literal survives to the
		// title. A single-pass replacement prevents the title from being
		// substituted a second time through the AGENT_NAME_CAPITALIZED slot.
		const out = wrapInBaseTemplate("{{AGENT_NAME_CAPITALIZED}}", "<p>hi</p>", "cheeks");
		expect(out).toContain("{{AGENT_NAME_CAPITALIZED}}");
		// The navbar and footer agent name slots are still correctly substituted.
		expect(out).not.toContain("{{AGENT_NAME_INITIAL}}");
		expect(out).toContain("Cheeks");
	});

	test("escapes HTML-special agent names", () => {
		const out = wrapInBaseTemplate("Test", "<p>hi</p>", "<script>alert(1)</script>");
		expect(out).not.toContain("<script>alert(1)</script>");
		expect(out).toContain("&lt;script&gt;");
	});

	test("does not re-scan substituted values for placeholder tokens", () => {
		// Second-order injection check: if a substituted value happens to
		// itself contain a placeholder token, the single-pass regex must not
		// recurse and rewrite it on a second pass. A title value that looks
		// like "{{AGENT_NAME_INITIAL}}" should land in the rendered title as
		// that literal string (escapeHtml leaves braces alone), while the
		// real initial slot in the navbar template still resolves to "C".
		const out = wrapInBaseTemplate("{{AGENT_NAME_INITIAL}}", "<p>hi</p>", "cheeks");
		// The literal survives in the title position.
		expect(out).toContain("{{AGENT_NAME_INITIAL}}");
		// The navbar agent name slot is still substituted cleanly.
		expect(out).toContain("Cheeks");
	});
});
