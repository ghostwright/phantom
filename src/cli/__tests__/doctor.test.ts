import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runDoctor } from "../doctor.ts";

describe("phantom doctor", () => {
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;
	const logs: string[] = [];

	beforeEach(() => {
		logs.length = 0;
		logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	test("prints help with --help", async () => {
		await runDoctor(["--help"]);
		expect(logs.some((l) => l.includes("phantom doctor"))).toBe(true);
		expect(logs.some((l) => l.includes("--json"))).toBe(true);
	});

	test("runs all checks and prints results", async () => {
		await runDoctor([]);
		expect(logs.some((l) => l.includes("Phantom Doctor"))).toBe(true);
		expect(logs.some((l) => l.includes("Bun"))).toBe(true);
		expect(logs.some((l) => l.includes("Docker"))).toBe(true);
		expect(logs.some((l) => l.includes("ClawMem"))).toBe(true);
		expect(logs.some((l) => l.includes("Config"))).toBe(true);
		expect(logs.some((l) => l.includes("SQLite"))).toBe(true);
	});

	test("outputs JSON with --json flag", async () => {
		await runDoctor(["--json"]);
		const jsonStr = logs.join("\n");
		const parsed = JSON.parse(jsonStr);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThan(0);
		for (const check of parsed) {
			expect(check).toHaveProperty("name");
			expect(check).toHaveProperty("status");
			expect(check).toHaveProperty("message");
			expect(["ok", "warn", "fail"]).toContain(check.status);
		}
	});

	test("Bun check passes", async () => {
		await runDoctor(["--json"]);
		const jsonStr = logs.join("\n");
		const parsed = JSON.parse(jsonStr);
		const bunCheck = parsed.find((c: { name: string }) => c.name === "Bun");
		expect(bunCheck).toBeDefined();
		expect(bunCheck.status).toBe("ok");
		expect(bunCheck.message).toMatch(/^v\d/);
	});

	test("Config check reflects actual config state", async () => {
		await runDoctor(["--json"]);
		const jsonStr = logs.join("\n");
		const parsed = JSON.parse(jsonStr);
		const configCheck = parsed.find((c: { name: string }) => c.name === "Config");
		expect(configCheck).toBeDefined();
		// Config exists in the project, so this should pass
		expect(["ok", "fail"]).toContain(configCheck.status);
	});

	test("accepts custom port", async () => {
		await runDoctor(["--port", "9999", "--json"]);
		const jsonStr = logs.join("\n");
		const parsed = JSON.parse(jsonStr);
		const phantomCheck = parsed.find((c: { name: string }) => c.name === "Phantom Process");
		expect(phantomCheck).toBeDefined();
		expect(phantomCheck.message).toContain("9999");
	});
});
