import { createAppAuth } from "@octokit/auth-app";
import { z } from "zod";

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

const GitHubAppEnvSchema = z.object({
	GITHUB_APP_ID: z.string().min(1),
	GITHUB_APP_CLIENT_ID: z.string().min(1),
	GITHUB_APP_INSTALLATION_ID: z
		.string()
		.min(1)
		.refine((val) => !Number.isNaN(Number.parseInt(val, 10)), {
			message: "GITHUB_APP_INSTALLATION_ID must be a valid number",
		}),
	GITHUB_APP_PRIVATE_KEY_B64: z.string().min(1),
});

export type GitHubAppEnvError = {
	missingVars: string[];
	message: string;
};

type GitHubAppConfig = {
	appId: string;
	clientId: string;
	installationId: number;
	privateKey: string;
};

type ValidationResult = { success: true; data: GitHubAppConfig } | { success: false; error: GitHubAppEnvError };

/**
 * Validates GitHub App environment variables.
 * Returns a result object rather than throwing to support doctor checks.
 */
export function validateGitHubAppEnv(): ValidationResult {
	const env = {
		GITHUB_APP_ID: process.env.GITHUB_APP_ID,
		GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
		GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
		GITHUB_APP_PRIVATE_KEY_B64: process.env.GITHUB_APP_PRIVATE_KEY_B64,
	};

	// Check for missing vars first (more helpful error)
	const missingVars = Object.entries(env)
		.filter(([_, value]) => !value)
		.map(([key]) => key);

	if (missingVars.length > 0) {
		return {
			success: false,
			error: {
				missingVars,
				message: `Missing GitHub App environment variables: ${missingVars.join(", ")}. See docs/security.md for setup instructions.`,
			},
		};
	}

	// Validate schema
	const result = GitHubAppEnvSchema.safeParse(env);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		return {
			success: false,
			error: {
				missingVars: [],
				message: `Invalid GitHub App configuration: ${issues}`,
			},
		};
	}

	// Decode and validate the private key
	let privateKey: string;
	try {
		privateKey = Buffer.from(result.data.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8");
		if (!privateKey.includes("-----BEGIN") || !privateKey.includes("PRIVATE KEY-----")) {
			throw new Error("Decoded value does not look like a PEM key");
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			error: {
				missingVars: [],
				message: `GITHUB_APP_PRIVATE_KEY_B64 is not valid base64 or does not contain a valid PEM key: ${msg}`,
			},
		};
	}

	return {
		success: true,
		data: {
			appId: result.data.GITHUB_APP_ID,
			clientId: result.data.GITHUB_APP_CLIENT_ID,
			installationId: Number.parseInt(result.data.GITHUB_APP_INSTALLATION_ID, 10),
			privateKey,
		},
	};
}

// Module-local token cache
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Clear the token cache. Used for testing.
 */
export function clearTokenCache(): void {
	cachedToken = null;
}

/**
 * Get an installation token for the configured GitHub App.
 * Tokens are cached and automatically refreshed 5 minutes before expiry.
 *
 * @throws Error if environment variables are missing or invalid
 * @throws Error if token acquisition fails
 */
export async function getInstallationToken(): Promise<string> {
	// Check cache first - return if valid and not expiring soon
	const now = Date.now();
	if (cachedToken && cachedToken.expiresAt - now > REFRESH_BUFFER_MS) {
		return cachedToken.token;
	}

	// Validate environment (lazy - only when we actually need a token)
	const validation = validateGitHubAppEnv();
	if (!validation.success) {
		throw new Error(validation.error.message);
	}

	const config = validation.data;

	// Create auth instance and get token
	const auth = createAppAuth({
		appId: config.appId,
		privateKey: config.privateKey,
		clientId: config.clientId,
	});

	const result = await auth({
		type: "installation",
		installationId: config.installationId,
	});

	// Cache the token
	cachedToken = {
		token: result.token,
		expiresAt: new Date(result.expiresAt).getTime(),
	};

	return result.token;
}
