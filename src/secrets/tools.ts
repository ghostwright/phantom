import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type McpSdkServerConfigWithInstance, createSdkMcpServer, tool } from "../agent/agent-sdk.ts";
import { createSecretRequest, getSecret } from "./store.ts";

type SecretToolDeps = {
	db: Database;
	baseUrl: string;
};

function ok(data: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

const FieldSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Machine-readable identifier used as the key when retrieving. Example: 'gitlab_token'"),
	label: z
		.string()
		.min(1)
		.max(200)
		.describe("Human-readable label shown in the form. Example: 'GitLab Personal Access Token'"),
	description: z
		.string()
		.max(1000)
		.optional()
		.describe("Help text shown below the label. Include instructions on where to find this credential."),
	type: z
		.enum(["password", "text"])
		.default("password")
		.describe("password: masked input (tokens, keys). text: visible input (URLs, usernames)."),
	required: z.boolean().default(true).describe("Whether this field must be filled before saving."),
	placeholder: z.string().max(200).optional().describe("Placeholder text. Example: 'glpat-xxxxxxxxxxxxxxxxxxxx'"),
	default: z.string().max(500).optional().describe("Default value pre-filled in the input."),
});

export function createSecretToolServer(deps: SecretToolDeps): McpSdkServerConfigWithInstance {
	const collectTool = tool(
		"phantom_collect_secrets",
		"Create a secure form to collect credentials from the user. " +
			"Returns a magic-link URL to send to the user via Slack. " +
			"The user fills in the form and secrets are encrypted and stored. " +
			"After the user confirms they saved credentials, retrieve them with phantom_get_secret. " +
			"Always check phantom_get_secret first to avoid re-asking.",
		{
			purpose: z
				.string()
				.min(1)
				.max(500)
				.describe("Why you need these credentials. Shown to the user. Example: 'access your GitLab repositories'"),
			fields: z.array(FieldSchema).min(1).max(10).describe("The credential fields to collect. 1-10 fields per form."),
			notify_channel: z.enum(["slack"]).default("slack").describe("Channel to notify when secrets are saved."),
			notify_channel_id: z
				.string()
				.optional()
				.describe("Slack channel ID where the conversation is happening (e.g. C04ABC123 or D04ABC123)."),
			notify_thread: z.string().optional().describe("Slack thread timestamp for the notification."),
		},
		async (input) => {
			try {
				const fields = input.fields.map((f) => ({
					name: f.name,
					label: f.label,
					description: f.description,
					type: f.type as "password" | "text",
					required: f.required,
					placeholder: f.placeholder,
					default: f.default,
				}));

				const { requestId, magicToken } = createSecretRequest(
					deps.db,
					fields,
					input.purpose,
					input.notify_channel,
					input.notify_channel_id ?? null,
					input.notify_thread ?? null,
				);

				const url = `${deps.baseUrl}/ui/secrets/${requestId}?magic=${magicToken}`;

				return ok({
					request_id: requestId,
					url,
					expires_in: "10 minutes",
					field_count: fields.length,
					field_names: fields.map((f) => f.name),
					note: "Send this URL to the user via Slack. Do not wrap it in Markdown formatting.",
				});
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	const getTool = tool(
		"phantom_get_secret",
		"Retrieve a previously stored secret by name. Returns the decrypted value " +
			"or an error if not found. Always check for existing secrets before " +
			"calling phantom_collect_secrets to avoid re-asking the user.",
		{
			name: z
				.string()
				.min(1)
				.max(100)
				.describe("The secret name as specified when collecting. Example: 'gitlab_token'"),
		},
		async ({ name }) => {
			try {
				const result = getSecret(deps.db, name);
				if (!result) {
					return ok({
						name,
						found: false,
						note: "No secret stored with this name. Use phantom_collect_secrets to request it from the user.",
					});
				}

				return ok({
					name,
					value: result.value,
					stored_at: result.storedAt,
				});
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-secrets",
		tools: [collectTool, getTool],
	});
}
