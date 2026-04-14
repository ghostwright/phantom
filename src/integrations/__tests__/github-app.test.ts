import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock @octokit/auth-app before importing the module under test
const mockAuth = mock(() =>
	Promise.resolve({
		token: "ghs_test_token_12345",
		expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
	}),
);

mock.module("@octokit/auth-app", () => ({
	createAppAuth: () => mockAuth,
}));

// Import after mocking
import { clearTokenCache, getInstallationToken, validateGitHubAppEnv } from "../github-app.ts";

describe("GitHub App Token Broker", () => {
	const validEnv = {
		GITHUB_APP_ID: "123456",
		GITHUB_APP_CLIENT_ID: "Iv1.abc123def456",
		GITHUB_APP_INSTALLATION_ID: "789012",
		GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(
			"-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
		).toString("base64"),
	};

	beforeEach(() => {
		// Clear any cached token between tests
		clearTokenCache();
		mockAuth.mockClear();

		// Set valid env vars by default
		for (const [key, value] of Object.entries(validEnv)) {
			process.env[key] = value;
		}
	});

	afterEach(() => {
		// Clean up env vars
		for (const key of Object.keys(validEnv)) {
			delete process.env[key];
		}
	});

	describe("validateGitHubAppEnv", () => {
		test("returns success when all env vars are present", () => {
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.appId).toBe("123456");
				expect(result.data.clientId).toBe("Iv1.abc123def456");
				expect(result.data.installationId).toBe(789012);
				expect(result.data.privateKey).toContain("BEGIN RSA PRIVATE KEY");
			}
		});

		test("returns error when GITHUB_APP_ID is missing", () => {
			process.env.GITHUB_APP_ID = undefined;
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.missingVars).toContain("GITHUB_APP_ID");
			}
		});

		test("returns error when GITHUB_APP_CLIENT_ID is missing", () => {
			process.env.GITHUB_APP_CLIENT_ID = undefined;
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.missingVars).toContain("GITHUB_APP_CLIENT_ID");
			}
		});

		test("returns error when GITHUB_APP_INSTALLATION_ID is missing", () => {
			process.env.GITHUB_APP_INSTALLATION_ID = undefined;
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.missingVars).toContain("GITHUB_APP_INSTALLATION_ID");
			}
		});

		test("returns error when GITHUB_APP_PRIVATE_KEY_B64 is missing", () => {
			process.env.GITHUB_APP_PRIVATE_KEY_B64 = undefined;
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.missingVars).toContain("GITHUB_APP_PRIVATE_KEY_B64");
			}
		});

		test("returns error when multiple env vars are missing", () => {
			process.env.GITHUB_APP_ID = undefined;
			process.env.GITHUB_APP_PRIVATE_KEY_B64 = undefined;
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.missingVars).toContain("GITHUB_APP_ID");
				expect(result.error.missingVars).toContain("GITHUB_APP_PRIVATE_KEY_B64");
			}
		});

		test("returns error when GITHUB_APP_INSTALLATION_ID is not a number", () => {
			process.env.GITHUB_APP_INSTALLATION_ID = "not-a-number";
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.message).toContain("GITHUB_APP_INSTALLATION_ID");
			}
		});

		test("returns error when GITHUB_APP_PRIVATE_KEY_B64 is invalid base64", () => {
			process.env.GITHUB_APP_PRIVATE_KEY_B64 = "not-valid-base64!!!";
			const result = validateGitHubAppEnv();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.message).toContain("base64");
			}
		});
	});

	describe("getInstallationToken", () => {
		test("returns a token from the GitHub App", async () => {
			const token = await getInstallationToken();
			expect(token).toBe("ghs_test_token_12345");
			expect(mockAuth).toHaveBeenCalledTimes(1);
		});

		test("returns cached token when more than 5 minutes from expiry", async () => {
			// First call - gets fresh token
			const token1 = await getInstallationToken();
			expect(token1).toBe("ghs_test_token_12345");
			expect(mockAuth).toHaveBeenCalledTimes(1);

			// Second call - should use cache
			const token2 = await getInstallationToken();
			expect(token2).toBe("ghs_test_token_12345");
			expect(mockAuth).toHaveBeenCalledTimes(1); // Still 1, not 2
		});

		test("refreshes token when within 5 minutes of expiry", async () => {
			// Mock a token that expires in 4 minutes (within 5-minute buffer)
			mockAuth.mockImplementationOnce(() =>
				Promise.resolve({
					token: "ghs_short_lived_token",
					expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(), // 4 minutes
				}),
			);

			// First call - gets the short-lived token
			const token1 = await getInstallationToken();
			expect(token1).toBe("ghs_short_lived_token");
			expect(mockAuth).toHaveBeenCalledTimes(1);

			// Reset mock to return a new token
			mockAuth.mockImplementation(() =>
				Promise.resolve({
					token: "ghs_refreshed_token",
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				}),
			);

			// Second call - should refresh because we're within 5-minute buffer
			const token2 = await getInstallationToken();
			expect(token2).toBe("ghs_refreshed_token");
			expect(mockAuth).toHaveBeenCalledTimes(2); // Called again
		});

		test("throws when env vars are missing", async () => {
			process.env.GITHUB_APP_ID = undefined;
			clearTokenCache();

			await expect(getInstallationToken()).rejects.toThrow("GITHUB_APP_ID");
		});

		test("token value never appears in error messages", async () => {
			// Get a token first
			await getInstallationToken();

			// Now cause an error by clearing env and cache
			process.env.GITHUB_APP_ID = undefined;
			clearTokenCache();

			try {
				await getInstallationToken();
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				expect(errorMessage).not.toContain("ghs_test_token_12345");
			}
		});
	});

	describe("token security", () => {
		test("token is not logged during normal operation", async () => {
			// Capture console.log calls
			const logCalls: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logCalls.push(args.map(String).join(" "));
			};

			try {
				await getInstallationToken();
				await getInstallationToken(); // Call twice to exercise cache path

				// Check no log call contains the token
				for (const call of logCalls) {
					expect(call).not.toContain("ghs_test_token_12345");
				}
			} finally {
				console.log = originalLog;
			}
		});

		test("token is not logged during error scenarios", async () => {
			const logCalls: string[] = [];
			const originalLog = console.log;
			const originalError = console.error;
			const originalWarn = console.warn;

			console.log = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));
			console.error = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));
			console.warn = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));

			try {
				// Get token successfully first
				await getInstallationToken();

				// Simulate an error scenario
				mockAuth.mockImplementationOnce(() => Promise.reject(new Error("API error")));
				clearTokenCache();

				try {
					await getInstallationToken();
				} catch {
					// Expected to throw
				}

				// Check no log call contains the token
				for (const call of logCalls) {
					expect(call).not.toContain("ghs_test_token_12345");
				}
			} finally {
				console.log = originalLog;
				console.error = originalError;
				console.warn = originalWarn;
			}
		});
	});
});
