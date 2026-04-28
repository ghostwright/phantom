import { parseArgs } from "node:util";
import { AGENT_SDK_MODULE_ENV } from "../agent/agent-sdk-loader.ts";

export type StartCliOptions = {
	help: boolean;
	port?: string;
	config?: string;
	daemon: boolean;
	agentSdkModule?: string;
};

export function parseStartArgs(args: string[]): StartCliOptions {
	const { values } = parseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			port: { type: "string", short: "p" },
			config: { type: "string", short: "c" },
			daemon: { type: "boolean", short: "d" },
			"agent-sdk-module": { type: "string" },
		},
		allowPositionals: false,
	});

	return {
		help: values.help === true,
		daemon: values.daemon === true,
		...(typeof values.port === "string" ? { port: values.port } : {}),
		...(typeof values.config === "string" ? { config: values.config } : {}),
		...(typeof values["agent-sdk-module"] === "string" ? { agentSdkModule: values["agent-sdk-module"] } : {}),
	};
}

export function applyStartEnv(options: StartCliOptions, env: Record<string, string | undefined>): void {
	if (options.port) {
		env.PHANTOM_PORT_OVERRIDE = options.port;
		env.PORT = options.port;
	}
	if (options.config) {
		env.PHANTOM_CONFIG_PATH = options.config;
	}
	if (options.agentSdkModule) {
		env[AGENT_SDK_MODULE_ENV] = options.agentSdkModule;
	}
}

export async function runStart(args: string[]): Promise<void> {
	const options = parseStartArgs(args);

	if (options.help) {
		console.log("phantom start - Start the Phantom agent\n");
		console.log("Usage: phantom start [options]\n");
		console.log("Options:");
		console.log("  -p, --port <port>     Override HTTP port");
		console.log("  -c, --config <path>   Path to phantom.yaml");
		console.log("  -d, --daemon          Run in background (detached)");
		console.log("  --agent-sdk-module    Runtime module specifier for the Agent SDK boundary");
		console.log("  -h, --help            Show this help");
		return;
	}

	if (options.daemon) {
		await startDaemon(options);
		return;
	}

	// Set overrides as environment variables so the main process reads them
	applyStartEnv(options, process.env);

	// Import and run main directly
	await import("../index.ts");
}

async function startDaemon(options: StartCliOptions): Promise<void> {
	const args = ["run", "src/index.ts"];
	const env: Record<string, string> = { ...process.env } as Record<string, string>;

	applyStartEnv(options, env);

	const proc = Bun.spawn(["bun", ...args], {
		env,
		stdio: ["ignore", "ignore", "ignore"],
	});

	// Detach from the parent process
	proc.unref();

	console.log(`Phantom started in background (PID: ${proc.pid})`);
	console.log("Check status: phantom status");
	console.log("View logs: phantom start (foreground) or check systemd journal");
}
