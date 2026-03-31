const COMMANDS: Record<string, string> = {
	start: "Start the Phantom agent",
	init: "Initialize a new Phantom configuration",
	doctor: "Check system health and diagnose issues",
	token: "Manage MCP authentication tokens",
	status: "Show quick status of the running Phantom",
};

function printHelp(): void {
	console.log("phantom - Autonomous AI co-worker\n");
	console.log("Usage: phantom <command> [options]\n");
	console.log("Commands:");
	for (const [cmd, desc] of Object.entries(COMMANDS)) {
		console.log(`  ${cmd.padEnd(12)} ${desc}`);
	}
	console.log("\nRun 'phantom <command> --help' for command-specific options.");
}

function printVersion(): void {
	console.log("phantom 0.18.2");
}

export async function runCli(argv: string[]): Promise<void> {
	const args = argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printHelp();
		return;
	}

	if (args[0] === "--version" || args[0] === "-v") {
		printVersion();
		return;
	}

	const command = args[0];
	const commandArgs = args.slice(1);

	switch (command) {
		case "start": {
			const { runStart } = await import("./start.ts");
			await runStart(commandArgs);
			break;
		}
		case "init": {
			const { runInit } = await import("./init.ts");
			await runInit(commandArgs);
			break;
		}
		case "doctor": {
			const { runDoctor } = await import("./doctor.ts");
			await runDoctor(commandArgs);
			break;
		}
		case "token": {
			const { runToken } = await import("./token.ts");
			await runToken(commandArgs);
			break;
		}
		case "status": {
			const { runStatus } = await import("./status.ts");
			await runStatus(commandArgs);
			break;
		}
		default:
			console.error(`Unknown command: ${command}`);
			console.error("Run 'phantom --help' for available commands.");
			process.exit(1);
	}
}
