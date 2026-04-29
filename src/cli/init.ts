import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { hashTokenSync } from "../mcp/config.ts";

type InitAnswers = {
	name: string;
	role: string;
	port: number;
	model: string;
	domain?: string;
	public_url?: string;
	effort?: string;
};

type SlackAnswers = {
	botToken: string;
	appToken: string;
	channelId: string;
	userId: string;
	ownerUserId: string;
};

async function prompt(
	rl: ReturnType<typeof createInterface>,
	question: string,
	defaultValue?: string,
): Promise<string> {
	const suffix = defaultValue ? ` [${defaultValue}]` : "";
	return new Promise((resolve) => {
		rl.question(`${question}${suffix}: `, (answer) => {
			resolve(answer.trim() || defaultValue || "");
		});
	});
}

function generatePhantomYaml(answers: InitAnswers): string {
	const config: Record<string, unknown> = {
		name: answers.name,
		port: answers.port,
		role: answers.role,
		model: answers.model,
		effort: answers.effort ?? "max",
		max_budget_usd: 0,
		timeout_minutes: 240,
	};
	if (answers.domain) {
		config.domain = answers.domain;
	}
	if (answers.public_url) {
		config.public_url = answers.public_url;
	}
	return YAML.stringify(config);
}

function generateMcpYaml(): { yaml: string; adminToken: string; operatorToken: string; readToken: string } {
	const adminToken = crypto.randomUUID();
	const operatorToken = crypto.randomUUID();
	const readToken = crypto.randomUUID();

	const config = {
		tokens: [
			{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
			{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
			{ name: "dashboard", hash: hashTokenSync(readToken), scopes: ["read"] },
		],
		rate_limit: {
			requests_per_minute: 60,
			burst: 10,
		},
	};

	return { yaml: YAML.stringify(config), adminToken, operatorToken, readToken };
}

function generateChannelsYaml(slack: SlackAnswers): string {
	const hasSlack = slack.botToken.length > 0;

	const ownerLine = slack.ownerUserId ? `\n  owner_user_id: ${slack.ownerUserId}` : "";
	const slackBlock = hasSlack
		? `slack:
  enabled: true
  bot_token: \${SLACK_BOT_TOKEN}
  app_token: \${SLACK_APP_TOKEN}${slack.channelId ? `\n  default_channel_id: ${slack.channelId}` : ""}${slack.userId && !slack.channelId ? `\n  default_user_id: ${slack.userId}` : ""}${ownerLine}`
		: `slack:
  enabled: false
  bot_token: \${SLACK_BOT_TOKEN}
  app_token: \${SLACK_APP_TOKEN}
  # default_channel_id: C04ABC123
  # default_user_id: U04ABC123
  # owner_user_id: U04ABC123`;

	return `# Channel configuration
# Environment variables are substituted at load time: \${VAR_NAME}

${slackBlock}

# telegram:
#   enabled: false
#   bot_token: \${TELEGRAM_BOT_TOKEN}

# email:
#   enabled: false
#   imap:
#     host: imap.gmail.com
#     port: 993
#     user: phantom@example.com
#     pass: \${EMAIL_PASSWORD}
#     tls: true
#   smtp:
#     host: smtp.gmail.com
#     port: 587
#     user: phantom@example.com
#     pass: \${EMAIL_PASSWORD}
#     tls: false
#   from_address: phantom@example.com
#   from_name: Phantom

# webhook:
#   enabled: false
#   secret: \${WEBHOOK_SECRET}
#   sync_timeout_ms: 25000
`;
}

function writeEnvLocal(botToken: string, appToken: string): void {
	const envPath = ".env.local";

	if (existsSync(envPath)) {
		const existing = readFileSync(envPath, "utf-8");
		const lines: string[] = [];
		if (!existing.includes("SLACK_BOT_TOKEN=")) {
			lines.push(`SLACK_BOT_TOKEN=${botToken}`);
		}
		if (!existing.includes("SLACK_APP_TOKEN=")) {
			lines.push(`SLACK_APP_TOKEN=${appToken}`);
		}
		if (lines.length > 0) {
			const prefix = existing.endsWith("\n") ? "" : "\n";
			appendFileSync(envPath, `${prefix}${lines.join("\n")}\n`);
		}
	} else {
		writeFileSync(envPath, `SLACK_BOT_TOKEN=${botToken}\nSLACK_APP_TOKEN=${appToken}\n`);
	}
}

export async function runInit(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			name: { type: "string" },
			role: { type: "string" },
			port: { type: "string" },
			yes: { type: "boolean", short: "y" },
		},
		allowPositionals: false,
	});

	if (values.help) {
		console.log("phantom init - Initialize a new Phantom configuration\n");
		console.log("Usage: phantom init [options]\n");
		console.log("Options:");
		console.log("  --name <name>    Agent name (default: phantom)");
		console.log("  --role <role>    Agent role: swe, base (default: swe)");
		console.log("  --port <port>    HTTP port (default: 3100)");
		console.log("  -y, --yes        Accept defaults without prompting");
		console.log("  -h, --help       Show this help");
		return;
	}

	if (existsSync("config/phantom.yaml")) {
		console.log("Phantom is already initialized. Config found at config/phantom.yaml");
		console.log("To reinitialize, remove the config/ directory first.");
		return;
	}

	let answers: InitAnswers;
	let slackAnswers: SlackAnswers = { botToken: "", appToken: "", channelId: "", userId: "", ownerUserId: "" };

	if (values.yes) {
		// Environment-aware: read from env vars set by cloud-init / .env / deploy scripts
		const envName = process.env.PHANTOM_NAME ?? process.env.AGENT_NAME;
		const envRole = process.env.PHANTOM_ROLE ?? process.env.AGENT_ROLE;
		const envPort = process.env.PORT;
		const envModel = process.env.PHANTOM_MODEL;
		const envDomain = process.env.PHANTOM_DOMAIN;
		const envPublicUrl = process.env.PHANTOM_PUBLIC_URL;
		const envEffort = process.env.PHANTOM_EFFORT;
		const envSlackBot = process.env.SLACK_BOT_TOKEN;
		const envSlackApp = process.env.SLACK_APP_TOKEN;
		const envSlackChannel = process.env.SLACK_CHANNEL_ID;
		const envSlackUser = process.env.SLACK_USER_ID;
		const envOwnerUser = process.env.OWNER_SLACK_USER_ID;

		answers = {
			name: values.name ?? envName ?? "phantom",
			role: values.role ?? envRole ?? "swe",
			port: values.port ? Number.parseInt(values.port, 10) : envPort ? Number.parseInt(envPort, 10) : 3100,
			model: envModel ?? "claude-opus-4-7",
			domain: envDomain,
			public_url: envPublicUrl,
			effort: envEffort,
		};

		// Auto-configure Slack if tokens exist in environment
		if (envSlackBot && envSlackApp) {
			slackAnswers = {
				botToken: envSlackBot,
				appToken: envSlackApp,
				channelId: envSlackChannel ?? "",
				userId: envSlackUser ?? "",
				ownerUserId: envOwnerUser ?? "",
			};
		}
	} else {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			console.log("Phantom Setup\n");
			answers = {
				name: values.name ?? (await prompt(rl, "Agent name", "phantom")),
				role: values.role ?? (await prompt(rl, "Role (swe, base)", "swe")),
				port: values.port
					? Number.parseInt(values.port, 10)
					: Number.parseInt(await prompt(rl, "HTTP port", "3100"), 10),
				model: await prompt(rl, "Model (claude-opus-4-7, claude-sonnet-4-6, claude-opus-4-6)", "claude-opus-4-7"),
			};

			console.log("\nSlack setup (optional, press Enter to skip):");
			const botToken = await prompt(rl, "  Bot Token (xoxb-...)");
			const appToken = botToken ? await prompt(rl, "  App Token (xapp-...)") : "";

			if (botToken && appToken) {
				const channelId = await prompt(rl, "  Default channel ID to introduce myself in");
				let userId = "";
				if (!channelId) {
					userId = await prompt(rl, "  Slack user ID to DM instead (U...)");
				}
				console.log("\n  Owner user ID restricts Phantom to only respond to one person.");
				console.log("  Find yours at: Slack profile > three dots > Copy member ID");
				const ownerUserId = await prompt(rl, "  Owner Slack user ID (U...)");
				slackAnswers = { botToken, appToken, channelId, userId, ownerUserId };
			}
		} finally {
			rl.close();
		}
	}

	// Create directories
	for (const dir of ["config", "config/roles", "phantom-config", "phantom-config/strategies", "data"]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	// Write config files
	writeFileSync("config/phantom.yaml", generatePhantomYaml(answers));
	console.log("  Created config/phantom.yaml");

	const mcp = generateMcpYaml();
	writeFileSync("config/mcp.yaml", mcp.yaml);
	console.log("  Created config/mcp.yaml");

	writeFileSync("config/channels.yaml", generateChannelsYaml(slackAnswers));
	console.log("  Created config/channels.yaml");

	// Write Slack tokens to .env.local if provided interactively
	// Skip when tokens came from environment (e.g., Specter VM where cloud-init writes .env)
	const tokensFromEnv = process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN;
	if (slackAnswers.botToken && slackAnswers.appToken && !tokensFromEnv) {
		writeEnvLocal(slackAnswers.botToken, slackAnswers.appToken);
		console.log("  Created .env.local with Slack tokens");
	}

	// Write initial evolved config files
	const configFiles: Record<string, string> = {
		"phantom-config/constitution.md": "# Constitution\n\nImmutable principles that govern this agent's behavior.\n",
		"phantom-config/persona.md": "# Persona\n\nCommunication style and personality traits.\n",
		"phantom-config/user-profile.md": "# User Profile\n\nPreferences and context about the user.\n",
		"phantom-config/domain-knowledge.md": "# Domain Knowledge\n\nAccumulated expertise and context.\n",
		"phantom-config/strategies/task-patterns.md": "# Task Patterns\n\nLearned approaches to common tasks.\n",
		"phantom-config/strategies/tool-preferences.md": "# Tool Preferences\n\nPreferred tools and workflows.\n",
		"phantom-config/strategies/error-recovery.md": "# Error Recovery\n\nLearned error handling strategies.\n",
	};

	for (const [filePath, content] of Object.entries(configFiles)) {
		if (!existsSync(filePath)) {
			writeFileSync(filePath, content);
		}
	}
	console.log("  Created phantom-config/ with initial files");

	console.log("\nPhantom initialized.\n");
	console.log("MCP tokens (save these, they will not be shown again):");
	console.log(`  Admin:    ${mcp.adminToken}`);
	console.log(`  Operator: ${mcp.operatorToken}`);
	console.log(`  Read:     ${mcp.readToken}`);

	if (slackAnswers.botToken) {
		console.log("\nSlack is configured. On first start, Phantom will introduce itself.");
	}

	console.log("\nNext steps:");
	console.log("  1. Set ANTHROPIC_API_KEY in your environment");
	console.log("  2. Start Docker services: docker compose up -d");
	console.log("  3. Start Phantom: phantom start");
	console.log("  4. Connect from Claude Code:");
	console.log(`     claude mcp add phantom -- curl -H "Authorization: Bearer ${mcp.adminToken}" https://your-host/mcp`);
}
