import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadMemoryConfig } from "../config.ts";

describe("loadMemoryConfig env overrides", () => {
	const origStorePath = process.env.CLAWMEM_STORE_PATH;
	const origModel = process.env.CLAWMEM_EMBED_MODEL;
	const origBusyTimeout = process.env.CLAWMEM_BUSY_TIMEOUT_MS;

	beforeEach(() => {
		delete process.env.CLAWMEM_STORE_PATH;
		delete process.env.CLAWMEM_EMBED_MODEL;
		delete process.env.CLAWMEM_BUSY_TIMEOUT_MS;
	});

	afterEach(() => {
		process.env.CLAWMEM_STORE_PATH = origStorePath;
		process.env.CLAWMEM_EMBED_MODEL = origModel;
		process.env.CLAWMEM_BUSY_TIMEOUT_MS = origBusyTimeout;
	});

	test("uses YAML defaults when no env vars set", () => {
		const config = loadMemoryConfig();
		expect(config.clawmem.store_path).toBe("data/clawmem.sqlite");
		expect(config.clawmem.embed_model).toBe("embedding");
		expect(config.clawmem.busy_timeout_ms).toBe(5000);
	});

	test("CLAWMEM_STORE_PATH env var overrides YAML config", () => {
		process.env.CLAWMEM_STORE_PATH = "tmp/test-memory.sqlite";
		const config = loadMemoryConfig();
		expect(config.clawmem.store_path).toBe("tmp/test-memory.sqlite");
	});

	test("CLAWMEM_EMBED_MODEL env var overrides YAML config", () => {
		process.env.CLAWMEM_EMBED_MODEL = "text-embedding-3-small";
		const config = loadMemoryConfig();
		expect(config.clawmem.embed_model).toBe("text-embedding-3-small");
	});

	test("CLAWMEM_BUSY_TIMEOUT_MS env var overrides YAML config", () => {
		process.env.CLAWMEM_BUSY_TIMEOUT_MS = "9000";
		const config = loadMemoryConfig();
		expect(config.clawmem.busy_timeout_ms).toBe(9000);
	});

	test("env vars override for missing YAML file (defaults path)", () => {
		process.env.CLAWMEM_STORE_PATH = "tmp/missing.sqlite";
		process.env.CLAWMEM_EMBED_MODEL = "voyage-3-large";
		const config = loadMemoryConfig("config/nonexistent.yaml");
		expect(config.clawmem.store_path).toBe("tmp/missing.sqlite");
		expect(config.clawmem.embed_model).toBe("voyage-3-large");
	});

	test("non-memory fields are preserved when env vars set", () => {
		process.env.CLAWMEM_STORE_PATH = "tmp/test-memory.sqlite";
		const config = loadMemoryConfig();
		expect(config.collections.episodes).toBe("episodes");
		expect(config.context.max_tokens).toBe(50000);
	});
});
