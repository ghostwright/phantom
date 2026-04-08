import { parseArgs } from "node:util";

type HealthResponse = {
	status: string;
	uptime: number;
	version: string;
	agent: string;
	role: { id: string; name: string };
	model?: string;
	model_source?: "config" | "env";
	channels: Record<string, boolean>;
	memory: { qdrant: boolean; ollama: boolean };
	evolution: {
		generation: number;
		session_count?: number;
		sessions_since_consolidation?: number;
		session_log_depth?: number;
	};
	onboarding?: string;
	peers?: Record<string, { healthy: boolean; latencyMs: number; error?: string }>;
};

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
}

export async function runStatus(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			json: { type: "boolean" },
			port: { type: "string", short: "p" },
			url: { type: "string", short: "u" },
		},
		allowPositionals: false,
	});

	if (values.help) {
		console.log("phantom status - Show quick status of the running Phantom\n");
		console.log("Usage: phantom status [options]\n");
		console.log("Options:");
		console.log("  --json             Output raw JSON from /health");
		console.log("  -p, --port <port>  Port to check (default: 3100)");
		console.log("  -u, --url <url>    Full URL to check (overrides port)");
		console.log("  -h, --help         Show this help");
		return;
	}

	const port = values.port ? Number.parseInt(values.port, 10) : 3100;
	const url = values.url ?? `http://localhost:${port}/health`;

	let data: HealthResponse;
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!resp.ok) {
			console.error(`Phantom returned HTTP ${resp.status}`);
			process.exit(1);
		}
		data = (await resp.json()) as HealthResponse;
	} catch {
		console.error(`Cannot reach Phantom at ${url}`);
		console.error("Is it running? Start with: phantom start");
		process.exit(1);
	}

	if (values.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	const channelList = Object.entries(data.channels)
		.filter(([_, connected]) => connected)
		.map(([name]) => name);

	const channelStr = channelList.length > 0 ? channelList.join(", ") : "none";
	const memoryStr =
		data.memory.qdrant && data.memory.ollama ? "ok" : data.memory.qdrant || data.memory.ollama ? "degraded" : "offline";

	const modelStr = data.model ? `${data.model}${data.model_source === "env" ? " (env override)" : ""}` : "unknown";

	const evo = data.evolution;
	const evoDetail =
		evo.session_count != null
			? `gen ${evo.generation} (${evo.session_count} sessions, ${evo.sessions_since_consolidation ?? 0} since consolidation, ${evo.session_log_depth ?? 0} queued)`
			: `gen ${evo.generation}`;

	console.log(
		`${data.agent} | ${data.role.name} | v${data.version} | ` +
			`${evoDetail} | ` +
			`model: ${modelStr} | ` +
			`up ${formatUptime(data.uptime)} | ` +
			`channels: ${channelStr} | ` +
			`memory: ${memoryStr}`,
	);

	if (data.peers && Object.keys(data.peers).length > 0) {
		const peerSummary = Object.entries(data.peers)
			.map(([name, info]) => `${name}(${info.healthy ? "ok" : "down"})`)
			.join(", ");
		console.log(`peers: ${peerSummary}`);
	}
}
