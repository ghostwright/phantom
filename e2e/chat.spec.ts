// End-to-end test for the Phantom chat flow.
// Requires a running Phantom instance with a real API key.
// Gated on PHANTOM_E2E_URL env var - skips in CI without a live agent.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PHANTOM_E2E_URL ?? "";

test.describe.configure({ mode: "serial" });

test.describe("Chat E2E", () => {
	test.skip(!BASE_URL, "PHANTOM_E2E_URL not set, skipping E2E tests");

	let sessionUrl = "";

	test("navigate to /chat and verify welcome state", async ({ page }) => {
		await page.goto(`${BASE_URL}/chat`);
		await page.waitForLoadState("networkidle");

		// The welcome state should be visible
		const heading = page.locator("h1, h2, [data-testid='welcome-heading']");
		await expect(heading.first()).toBeVisible({ timeout: 10000 });
	});

	test("send a message and verify streaming response", async ({ page }) => {
		await page.goto(`${BASE_URL}/chat`);
		await page.waitForLoadState("networkidle");

		// Type a message
		const input = page.locator('textarea[aria-label="Message input"]');
		await input.fill("What is 2 + 2?");
		await input.press("Enter");

		// Wait for streaming to start - an assistant message should appear
		const assistantMessage = page.locator('[data-role="assistant"], .assistant-message').first();
		await expect(assistantMessage).toBeVisible({ timeout: 30000 });

		// Wait for the stop button to disappear (streaming complete)
		const stopButton = page.locator('button[aria-label="Stop generation"]');
		await expect(stopButton).toBeHidden({ timeout: 120000 });

		// Verify response contains "4"
		const responseText = await page.locator('[data-role="assistant"], .assistant-message').first().textContent();
		expect(responseText).toContain("4");

		// Store the URL for later tests
		sessionUrl = page.url();
	});

	test("sidebar shows the session", async ({ page }) => {
		if (!sessionUrl) test.skip();
		await page.goto(sessionUrl);
		await page.waitForLoadState("networkidle");

		// The sidebar should show at least one session
		const sidebarItem = page.locator('[data-testid="session-item"], [role="listitem"]').first();
		await expect(sidebarItem).toBeVisible({ timeout: 10000 });
	});

	test("refresh page and verify history loads", async ({ page }) => {
		if (!sessionUrl) test.skip();
		await page.goto(sessionUrl);
		await page.waitForLoadState("networkidle");

		// Wait for messages to load
		await page.waitForTimeout(2000);

		// The user message should be visible
		const userMessage = page.locator("text=What is 2 + 2?").first();
		await expect(userMessage).toBeVisible({ timeout: 10000 });

		// The assistant's response should be visible
		const assistantText = page.locator('[data-role="assistant"], .assistant-message').first();
		await expect(assistantText).toBeVisible({ timeout: 10000 });
	});

	test("send another message, click stop, verify partial preservation", async ({ page }) => {
		if (!sessionUrl) test.skip();
		await page.goto(sessionUrl);
		await page.waitForLoadState("networkidle");

		// Wait for history to load
		await page.waitForTimeout(2000);

		const input = page.locator('textarea[aria-label="Message input"]');
		await input.fill("Tell me a very long joke with lots of setup and a punchline at the end");
		await input.press("Enter");

		// Wait for streaming to start
		const stopButton = page.locator('button[aria-label="Stop generation"]');
		await expect(stopButton).toBeVisible({ timeout: 30000 });

		// Wait a moment for some content to stream
		await page.waitForTimeout(3000);

		// Click stop
		if (await stopButton.isVisible()) {
			await stopButton.click();
		}

		// Wait for streaming to actually stop
		await expect(stopButton).toBeHidden({ timeout: 15000 });

		// Verify the partial message is preserved (not blank)
		const messages = page.locator('[data-role="assistant"], .assistant-message');
		const lastMessage = messages.last();
		const text = await lastMessage.textContent();
		// The message should have some content (not be empty)
		expect(text?.length).toBeGreaterThan(0);
	});
});
