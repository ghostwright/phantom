// Storage layer for /ui/api/phantom-config.
//
// Reads phantom.yaml + channels.yaml + phantom-config/meta/evolution.json +
// config/memory.yaml off disk and projects them into the UI shape. Also owns
// the deep-merge + write plan for PUTs. The handler in phantom-config.ts
// orchestrates this module; keeping the IO + projection pieces here makes the
// handler thin enough to audit at a glance.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { EvolutionUiConfigSchema, PermissionsConfigSchema } from "../../config/schemas.ts";
import type {
	AppliedChange,
	PhantomConfigForUi,
	PhantomConfigPaths,
	PhantomConfigPut,
	SectionKey,
} from "./phantom-config-schemas.ts";

const DEFAULT_PATHS: PhantomConfigPaths = {
	phantomYaml: "config/phantom.yaml",
	channelsYaml: "config/channels.yaml",
	evolutionMeta: "phantom-config/meta/evolution.json",
};

export function resolvePaths(overrides?: Partial<PhantomConfigPaths>): PhantomConfigPaths {
	return {
		phantomYaml: overrides?.phantomYaml ?? DEFAULT_PATHS.phantomYaml,
		channelsYaml: overrides?.channelsYaml ?? DEFAULT_PATHS.channelsYaml,
		evolutionMeta: overrides?.evolutionMeta ?? DEFAULT_PATHS.evolutionMeta,
	};
}

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function readYamlFile(path: string): ReadResult<Record<string, unknown>> {
	if (!existsSync(path)) return { ok: true, value: {} };
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to read ${path}: ${msg}` };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Invalid YAML at ${path}: ${msg}` };
	}
	if (parsed == null) return { ok: true, value: {} };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: `${path} must be a YAML object at the top level` };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

export function readJsonFile(path: string): ReadResult<Record<string, unknown>> {
	if (!existsSync(path)) return { ok: true, value: {} };
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to read ${path}: ${msg}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Invalid JSON at ${path}: ${msg}` };
	}
	if (parsed == null) return { ok: true, value: {} };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: `${path} must be a JSON object at the top level` };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

export type LoadedConfig = {
	phantom: Record<string, unknown>;
	channels: Record<string, unknown>;
	evolutionMeta: Record<string, unknown>;
};

export function loadAllConfig(paths: PhantomConfigPaths): ReadResult<LoadedConfig> {
	const phantom = readYamlFile(paths.phantomYaml);
	if (!phantom.ok) return phantom;
	const channels = readYamlFile(paths.channelsYaml);
	if (!channels.ok) return channels;
	const evolutionMeta = readJsonFile(paths.evolutionMeta);
	if (!evolutionMeta.ok) return evolutionMeta;
	return {
		ok: true,
		value: {
			phantom: phantom.value,
			channels: channels.value,
			evolutionMeta: evolutionMeta.value,
		},
	};
}

function readMemoryConfig(): PhantomConfigForUi["memory"] {
	const res = readYamlFile("config/memory.yaml");
	const fallback: PhantomConfigForUi["memory"] = {
		qdrant_url: "http://localhost:6333",
		ollama_url: "http://localhost:11434",
		embedding_model: "nomic-embed-text",
		episode_limit: 10,
		fact_limit: 20,
		procedure_limit: 5,
	};
	if (!res.ok) return fallback;
	const m = res.value;
	const qdrant = (m.qdrant as Record<string, unknown> | undefined) ?? {};
	const ollama = (m.ollama as Record<string, unknown> | undefined) ?? {};
	const context = (m.context as Record<string, unknown> | undefined) ?? {};
	return {
		qdrant_url: typeof qdrant.url === "string" ? qdrant.url : fallback.qdrant_url,
		ollama_url: typeof ollama.url === "string" ? ollama.url : fallback.ollama_url,
		embedding_model: typeof ollama.model === "string" ? ollama.model : fallback.embedding_model,
		episode_limit: typeof context.episode_limit === "number" ? context.episode_limit : fallback.episode_limit,
		fact_limit: typeof context.fact_limit === "number" ? context.fact_limit : fallback.fact_limit,
		procedure_limit: typeof context.procedure_limit === "number" ? context.procedure_limit : fallback.procedure_limit,
	};
}

// Build the UI-facing shape from the three source files. Defaults are applied
// at this layer so partially-configured deployments (e.g. no channels.yaml)
// still render a complete form.
export function projectToUi(loaded: LoadedConfig): PhantomConfigForUi {
	const p = loaded.phantom;
	const c = loaded.channels;
	const evMeta = loaded.evolutionMeta;

	const permissions = PermissionsConfigSchema.parse(p.permissions ?? {});
	const evYaml = EvolutionUiConfigSchema.parse(p.evolution ?? {});
	// Cadence overlay in phantom-config/meta/evolution.json wins over the
	// phantom.yaml mirror at runtime; the UI surface reports the overlay
	// value so the form reflects what the running cadence actually sees.
	const cadenceOverlay =
		typeof evMeta.cadence_minutes === "number"
			? evMeta.cadence_minutes
			: typeof evMeta.cadenceMinutes === "number"
				? evMeta.cadenceMinutes
				: null;
	const depthOverlay =
		typeof evMeta.demand_trigger_depth === "number"
			? evMeta.demand_trigger_depth
			: typeof evMeta.demandTriggerDepth === "number"
				? evMeta.demandTriggerDepth
				: null;
	const evolution = {
		reflection_enabled: evYaml.reflection_enabled,
		cadence_minutes: cadenceOverlay ?? evYaml.cadence_minutes,
		demand_trigger_depth: depthOverlay ?? evYaml.demand_trigger_depth,
	};

	const channels = {
		slack: { enabled: Boolean((c.slack as Record<string, unknown> | undefined)?.enabled) },
		telegram: { enabled: Boolean((c.telegram as Record<string, unknown> | undefined)?.enabled) },
		email: { enabled: Boolean((c.email as Record<string, unknown> | undefined)?.enabled) },
		webhook: { enabled: Boolean((c.webhook as Record<string, unknown> | undefined)?.enabled) },
	};

	return {
		name: typeof p.name === "string" ? p.name : "phantom",
		role: typeof p.role === "string" ? p.role : "swe",
		public_url: typeof p.public_url === "string" ? p.public_url : null,
		domain: typeof p.domain === "string" ? p.domain : null,
		model: typeof p.model === "string" ? p.model : "claude-opus-4-7",
		judge_model: typeof p.judge_model === "string" ? p.judge_model : null,
		effort: (typeof p.effort === "string" ? p.effort : "max") as PhantomConfigForUi["effort"],
		max_budget_usd: typeof p.max_budget_usd === "number" ? p.max_budget_usd : 0,
		timeout_minutes: typeof p.timeout_minutes === "number" ? p.timeout_minutes : 240,
		permissions,
		evolution,
		channels,
		memory: readMemoryConfig(),
	};
}

// Structural deep equal. Arrays are atomic; plain objects recurse. Mirrors the
// settings-editor storage.ts helper so dirty detection semantics match.
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
		return true;
	}
	if (typeof a === "object" && typeof b === "object") {
		const ak = Object.keys(a as object);
		const bk = Object.keys(b as object);
		if (ak.length !== bk.length) return false;
		for (const k of ak) {
			if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
			if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
		}
		return true;
	}
	return false;
}

function sectionForTopScalar(field: string): SectionKey {
	if (
		field === "model" ||
		field === "judge_model" ||
		field === "effort" ||
		field === "max_budget_usd" ||
		field === "timeout_minutes"
	) {
		return "model_cost";
	}
	return "identity";
}

export function applyPatch(
	current: PhantomConfigForUi,
	patch: PhantomConfigPut,
): { merged: PhantomConfigForUi; changes: AppliedChange[] } {
	const merged: PhantomConfigForUi = {
		...current,
		permissions: { ...current.permissions },
		evolution: { ...current.evolution },
		channels: {
			slack: { ...current.channels.slack },
			telegram: { ...current.channels.telegram },
			email: { ...current.channels.email },
			webhook: { ...current.channels.webhook },
		},
		memory: { ...current.memory },
	};
	const changes: AppliedChange[] = [];

	const topScalars = [
		"name",
		"role",
		"public_url",
		"domain",
		"model",
		"judge_model",
		"effort",
		"max_budget_usd",
		"timeout_minutes",
	] as const;
	for (const k of topScalars) {
		if (patch[k] === undefined) continue;
		const next = patch[k];
		if (deepEqual(current[k], next)) continue;
		changes.push({ section: sectionForTopScalar(k), field: k, previous: current[k], next });
		(merged as Record<string, unknown>)[k] = next;
	}

	if (patch.permissions) {
		for (const key of Object.keys(patch.permissions) as Array<keyof typeof patch.permissions>) {
			const val = patch.permissions[key];
			if (val === undefined) continue;
			const prev = current.permissions[key];
			if (deepEqual(prev, val)) continue;
			changes.push({ section: "permissions", field: `permissions.${key}`, previous: prev, next: val });
			(merged.permissions as Record<string, unknown>)[key] = val;
		}
	}

	if (patch.evolution) {
		for (const key of Object.keys(patch.evolution) as Array<keyof typeof patch.evolution>) {
			const val = patch.evolution[key];
			if (val === undefined) continue;
			const prev = current.evolution[key];
			if (deepEqual(prev, val)) continue;
			changes.push({ section: "evolution", field: `evolution.${key}`, previous: prev, next: val });
			(merged.evolution as Record<string, unknown>)[key] = val;
		}
	}

	if (patch.channels) {
		for (const ch of ["slack", "telegram", "email", "webhook"] as const) {
			const entry = patch.channels[ch];
			if (entry?.enabled === undefined) continue;
			const prev = current.channels[ch].enabled;
			if (prev === entry.enabled) continue;
			changes.push({
				section: "channels",
				field: `channels.${ch}.enabled`,
				previous: prev,
				next: entry.enabled,
			});
			merged.channels[ch] = { enabled: entry.enabled };
		}
	}

	if (patch.memory) {
		for (const key of Object.keys(patch.memory) as Array<keyof typeof patch.memory>) {
			const val = patch.memory[key];
			if (val === undefined) continue;
			const prev = current.memory[key];
			if (deepEqual(prev, val)) continue;
			changes.push({ section: "memory", field: `memory.${key}`, previous: prev, next: val });
			(merged.memory as Record<string, unknown>)[key] = val;
		}
	}

	return { merged, changes };
}

export type WritePlan = {
	phantom: Record<string, unknown>;
	channels: Record<string, unknown>;
	memory: Record<string, unknown>;
	evolutionMeta: Record<string, unknown>;
};

// Project the merged UI shape back into the on-disk file layouts. phantom.yaml
// gets identity + model + cost + permissions + evolution. channels.yaml keeps
// secrets and owner ids untouched and only overwrites enabled. memory.yaml
// preserves collections + embedding dims + context.max_tokens. The cadence
// overlay mirrors the cadence fields so the running EvolutionCadence picks
// them up on the next tick.
export function planWrites(
	previous: LoadedConfig,
	merged: PhantomConfigForUi,
	// memoryBefore may be null when the caller skipped the memory.yaml read
	// because the patch does not touch memory. The resulting plan.memory is
	// unused in that case (the caller gates the write on changes), so we
	// return a minimal object to satisfy the WritePlan shape.
	memoryBefore: Record<string, unknown> | null,
): WritePlan {
	const phantom: Record<string, unknown> = { ...previous.phantom };
	phantom.name = merged.name;
	phantom.role = merged.role;
	// yaml.stringify drops undefined values, matching the behavior of a
	// deleted property without tripping the noDelete lint rule.
	phantom.public_url = merged.public_url ? merged.public_url : undefined;
	phantom.domain = merged.domain ? merged.domain : undefined;
	phantom.model = merged.model;
	phantom.judge_model = merged.judge_model ? merged.judge_model : undefined;
	phantom.effort = merged.effort;
	phantom.max_budget_usd = merged.max_budget_usd;
	phantom.timeout_minutes = merged.timeout_minutes;
	phantom.permissions = merged.permissions;
	phantom.evolution = {
		reflection_enabled: merged.evolution.reflection_enabled,
		cadence_minutes: merged.evolution.cadence_minutes,
		demand_trigger_depth: merged.evolution.demand_trigger_depth,
	};

	const channels: Record<string, unknown> = { ...previous.channels };
	for (const ch of ["slack", "telegram", "email", "webhook"] as const) {
		const existing = (channels[ch] as Record<string, unknown> | undefined) ?? {};
		channels[ch] = { ...existing, enabled: merged.channels[ch].enabled };
	}

	const memory: Record<string, unknown> = memoryBefore ? { ...memoryBefore } : {};
	memory.qdrant = { ...((memory.qdrant as Record<string, unknown> | undefined) ?? {}), url: merged.memory.qdrant_url };
	memory.ollama = {
		...((memory.ollama as Record<string, unknown> | undefined) ?? {}),
		url: merged.memory.ollama_url,
		model: merged.memory.embedding_model,
	};
	memory.context = {
		...((memory.context as Record<string, unknown> | undefined) ?? {}),
		episode_limit: merged.memory.episode_limit,
		fact_limit: merged.memory.fact_limit,
		procedure_limit: merged.memory.procedure_limit,
	};

	const evolutionMeta: Record<string, unknown> = { ...previous.evolutionMeta };
	evolutionMeta.cadence_minutes = merged.evolution.cadence_minutes;
	evolutionMeta.demand_trigger_depth = merged.evolution.demand_trigger_depth;

	return { phantom, channels, memory, evolutionMeta };
}
