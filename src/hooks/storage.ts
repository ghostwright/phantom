// Storage for the hooks slice of settings.json. Every write goes through
// src/plugins/settings-io.ts for atomic tmp+rename so no other field can be
// accidentally clobbered. The hooks editor ONLY touches Settings.hooks; every
// other key (enabledPlugins, permissions, model, etc.) is preserved
// byte-for-byte on a round trip.
//
// Concurrency: last-write-wins per the Cardinal Rule. Agent-originated edits
// via the Write tool bypass this path; if the agent edits hooks between the
// dashboard's read and the dashboard's write, the dashboard overwrites. An
// audit log row captures the previous slice so a human can diff and recover.

import { readSettings, writeSettings } from "../plugins/settings-io.ts";
import { getHooksSettingsPath } from "./paths.ts";
import {
	EVENTS_SUPPORTING_MATCHER,
	type HookDefinition,
	type HookEvent,
	type HookMatcherGroup,
	type HooksSlice,
	HooksSliceSchema,
	isHttpUrlAllowed,
} from "./schema.ts";

// Shared guard that keeps every mutation path consistent: Notification,
// UserPromptSubmit, SessionStart, etc. do not accept a matcher. Before
// the fix the server accepted any matcher on any event and silently
// wrote a file the CLI would ignore at runtime. This check runs on
// installHook, updateHook, and relocateHook.
function checkMatcherCompatibility(
	event: HookEvent,
	matcher: string | undefined,
): { ok: true } | { ok: false; error: string } {
	if (matcher && matcher.length > 0 && !EVENTS_SUPPORTING_MATCHER.has(event)) {
		return {
			ok: false,
			error: `Event ${event} does not accept a matcher. Leave the matcher field blank for this event.`,
		};
	}
	return { ok: true };
}

export type ListHooksResult =
	| { ok: true; slice: HooksSlice; total: number; allowedHttpHookUrls: string[] | undefined }
	| { ok: false; error: string };

export function listHooks(settingsPath: string = getHooksSettingsPath()): ListHooksResult {
	const read = readSettings(settingsPath);
	if (!read.ok) {
		return { ok: false, error: read.error };
	}
	const rawSlice = (read.settings.hooks ?? {}) as unknown;
	const parsed = HooksSliceSchema.safeParse(rawSlice);
	if (!parsed.success) {
		return { ok: false, error: `On-disk hooks slice is invalid: ${parsed.error.issues[0].message}` };
	}
	let total = 0;
	for (const groups of Object.values(parsed.data)) {
		for (const group of groups ?? []) {
			total += group.hooks.length;
		}
	}
	const allowedHttpHookUrls = Array.isArray(read.settings.allowedHttpHookUrls)
		? (read.settings.allowedHttpHookUrls as string[])
		: undefined;
	return { ok: true, slice: parsed.data, total, allowedHttpHookUrls };
}

export type InstallHookInput = {
	event: HookEvent;
	matcher?: string;
	definition: HookDefinition;
};

export type InstallHookResult =
	| {
			ok: true;
			slice: HooksSlice;
			event: HookEvent;
			matcher?: string;
			groupIndex: number;
			hookIndex: number;
			previousSlice: HooksSlice;
	  }
	| { ok: false; status: 400 | 403 | 422 | 500; error: string };

// Install a new hook. Appends to an existing matcher group with the same
// matcher, or creates a new matcher group if none exists for that matcher.
// Writes ONLY the Settings.hooks slice back; all other keys preserved.
export function installHook(input: InstallHookInput, settingsPath: string = getHooksSettingsPath()): InstallHookResult {
	const compat = checkMatcherCompatibility(input.event, input.matcher);
	if (!compat.ok) {
		return { ok: false, status: 422, error: compat.error };
	}

	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevRaw = (read.settings.hooks ?? {}) as unknown;
	const prevParsed = HooksSliceSchema.safeParse(prevRaw);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;

	// allowlist enforcement for http hooks
	if (input.definition.type === "http") {
		const allowlist = Array.isArray(read.settings.allowedHttpHookUrls)
			? (read.settings.allowedHttpHookUrls as string[])
			: undefined;
		if (!isHttpUrlAllowed(input.definition.url, allowlist)) {
			return {
				ok: false,
				status: 403,
				error: `HTTP hook URL ${input.definition.url} is not on the allowedHttpHookUrls allowlist. Patterns are anchored full-string matches; append '*' to allow query strings or fragments (for example 'https://hooks.example.com/webhook*').`,
			};
		}
	}

	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));
	const groupsForEvent: HookMatcherGroup[] = (nextSlice[input.event] as HookMatcherGroup[] | undefined) ?? [];

	// Find an existing group with the same matcher. Treat undefined matcher
	// as its own category (the "no matcher" group).
	let groupIndex = groupsForEvent.findIndex((g) => (g.matcher ?? null) === (input.matcher ?? null));
	if (groupIndex === -1) {
		groupsForEvent.push({
			matcher: input.matcher,
			hooks: [input.definition],
		});
		groupIndex = groupsForEvent.length - 1;
	} else {
		groupsForEvent[groupIndex].hooks.push(input.definition);
	}
	nextSlice[input.event] = groupsForEvent;

	const validated = HooksSliceSchema.safeParse(nextSlice);
	if (!validated.success) {
		return {
			ok: false,
			status: 422,
			error: `Hook validation failed: ${validated.error.issues[0].path.join(".")}: ${validated.error.issues[0].message}`,
		};
	}

	const merged = { ...read.settings, hooks: validated.data };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) {
		return { ok: false, status: 500, error: write.error };
	}

	const hookIndex = (validated.data[input.event]?.[groupIndex]?.hooks.length ?? 1) - 1;
	return {
		ok: true,
		slice: validated.data,
		event: input.event,
		matcher: input.matcher,
		groupIndex,
		hookIndex,
		previousSlice,
	};
}

export type UpdateHookInput = {
	event: HookEvent;
	groupIndex: number;
	hookIndex: number;
	definition: HookDefinition;
};

export type UpdateHookResult =
	| { ok: true; slice: HooksSlice; previousSlice: HooksSlice; previousMatcher: string | undefined }
	| { ok: false; status: 404 | 403 | 422 | 500; error: string };

export function updateHook(input: UpdateHookInput, settingsPath: string = getHooksSettingsPath()): UpdateHookResult {
	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevParsed = HooksSliceSchema.safeParse((read.settings.hooks ?? {}) as unknown);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;
	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));
	const groups = nextSlice[input.event];
	if (!groups || groups.length <= input.groupIndex || !groups[input.groupIndex]) {
		return { ok: false, status: 404, error: `No matcher group at ${input.event}[${input.groupIndex}]` };
	}
	const group = groups[input.groupIndex];
	const previousMatcher = group.matcher;
	if (!group.hooks || group.hooks.length <= input.hookIndex) {
		return {
			ok: false,
			status: 404,
			error: `No hook at ${input.event}[${input.groupIndex}].hooks[${input.hookIndex}]`,
		};
	}

	if (input.definition.type === "http") {
		const allowlist = Array.isArray(read.settings.allowedHttpHookUrls)
			? (read.settings.allowedHttpHookUrls as string[])
			: undefined;
		if (!isHttpUrlAllowed(input.definition.url, allowlist)) {
			return {
				ok: false,
				status: 403,
				error: `HTTP hook URL ${input.definition.url} is not on the allowedHttpHookUrls allowlist. Patterns are anchored full-string matches; append '*' to allow query strings or fragments.`,
			};
		}
	}

	group.hooks[input.hookIndex] = input.definition;
	const validated = HooksSliceSchema.safeParse(nextSlice);
	if (!validated.success) {
		return {
			ok: false,
			status: 422,
			error: `Hook validation failed: ${validated.error.issues[0].message}`,
		};
	}
	const merged = { ...read.settings, hooks: validated.data };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) return { ok: false, status: 500, error: write.error };

	return { ok: true, slice: validated.data, previousSlice, previousMatcher };
}

// Relocate a hook between coordinates. This is the atomic operation the
// dashboard edit form uses when the operator changes the event or the
// matcher on an existing hook. Before the fix there was no way to do
// this safely: the client had to delete the old entry and install a new
// one in two round trips, which could leave a duplicate or a hole if the
// second call failed. relocateHook does the splice + append + validate
// + write in one pass, with a single atomic settings.json write.
//
// Flow:
//   1. Read settings.json atomically.
//   2. Validate the source coordinate exists.
//   3. Enforce event/matcher compatibility on the destination.
//   4. Splice the hook out of the source group.
//   5. Drop the source group if it is now empty, drop the event key if
//      the last group is empty.
//   6. Find or create the destination matcher group and append the
//      new definition at the end.
//   7. Zod-validate the full slice.
//   8. Write atomically via settings-io.
//
// If any step fails the in-memory clone is discarded and nothing is
// written, so the on-disk file is never left half-updated.
export type RelocateHookInput = {
	fromEvent: HookEvent;
	fromGroupIndex: number;
	fromHookIndex: number;
	toEvent: HookEvent;
	toMatcher?: string;
	definition: HookDefinition;
};

export type RelocateHookResult =
	| {
			ok: true;
			slice: HooksSlice;
			previousSlice: HooksSlice;
			previousMatcher: string | undefined;
			newGroupIndex: number;
			newHookIndex: number;
	  }
	| { ok: false; status: 404 | 403 | 422 | 500; error: string };

export function relocateHook(
	input: RelocateHookInput,
	settingsPath: string = getHooksSettingsPath(),
): RelocateHookResult {
	const compat = checkMatcherCompatibility(input.toEvent, input.toMatcher);
	if (!compat.ok) {
		return { ok: false, status: 422, error: compat.error };
	}

	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevParsed = HooksSliceSchema.safeParse((read.settings.hooks ?? {}) as unknown);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;
	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));

	const fromGroups = nextSlice[input.fromEvent];
	if (!fromGroups || fromGroups.length <= input.fromGroupIndex || !fromGroups[input.fromGroupIndex]) {
		return {
			ok: false,
			status: 404,
			error: `No matcher group at ${input.fromEvent}[${input.fromGroupIndex}]`,
		};
	}
	const fromGroup = fromGroups[input.fromGroupIndex];
	if (!fromGroup.hooks || fromGroup.hooks.length <= input.fromHookIndex) {
		return {
			ok: false,
			status: 404,
			error: `No hook at ${input.fromEvent}[${input.fromGroupIndex}].hooks[${input.fromHookIndex}]`,
		};
	}
	const previousMatcher = fromGroup.matcher;

	// Enforce the http allowlist on the replacement definition same as
	// installHook / updateHook. Without this check a relocate could sneak
	// a URL past the allowlist by going through the relocate route.
	if (input.definition.type === "http") {
		const allowlist = Array.isArray(read.settings.allowedHttpHookUrls)
			? (read.settings.allowedHttpHookUrls as string[])
			: undefined;
		if (!isHttpUrlAllowed(input.definition.url, allowlist)) {
			return {
				ok: false,
				status: 403,
				error: `HTTP hook URL ${input.definition.url} is not on the allowedHttpHookUrls allowlist. Patterns are anchored full-string matches; append '*' to allow query strings or fragments.`,
			};
		}
	}

	fromGroup.hooks.splice(input.fromHookIndex, 1);
	if (fromGroup.hooks.length === 0) {
		fromGroups.splice(input.fromGroupIndex, 1);
	}
	if (fromGroups.length === 0) {
		delete nextSlice[input.fromEvent];
	}

	const toGroups: HookMatcherGroup[] = (nextSlice[input.toEvent] as HookMatcherGroup[] | undefined) ?? [];
	const toMatcherKey = input.toMatcher && input.toMatcher.length > 0 ? input.toMatcher : undefined;
	let newGroupIndex = toGroups.findIndex((g) => (g.matcher ?? null) === (toMatcherKey ?? null));
	if (newGroupIndex === -1) {
		toGroups.push({ matcher: toMatcherKey, hooks: [input.definition] });
		newGroupIndex = toGroups.length - 1;
	} else {
		toGroups[newGroupIndex].hooks.push(input.definition);
	}
	nextSlice[input.toEvent] = toGroups;

	const validated = HooksSliceSchema.safeParse(nextSlice);
	if (!validated.success) {
		return {
			ok: false,
			status: 422,
			error: `Hook validation failed: ${validated.error.issues[0].path.join(".")}: ${validated.error.issues[0].message}`,
		};
	}
	const merged = { ...read.settings, hooks: validated.data };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) return { ok: false, status: 500, error: write.error };

	const finalGroup = validated.data[input.toEvent]?.[newGroupIndex];
	const newHookIndex = (finalGroup?.hooks.length ?? 1) - 1;
	return { ok: true, slice: validated.data, previousSlice, previousMatcher, newGroupIndex, newHookIndex };
}

export type UninstallHookInput = {
	event: HookEvent;
	groupIndex: number;
	hookIndex: number;
};

export type UninstallHookResult =
	| {
			ok: true;
			slice: HooksSlice;
			previousSlice: HooksSlice;
			previousMatcher: string | undefined;
			previousHookType: HookDefinition["type"] | undefined;
	  }
	| { ok: false; status: 404 | 422 | 500; error: string };

export function uninstallHook(
	input: UninstallHookInput,
	settingsPath: string = getHooksSettingsPath(),
): UninstallHookResult {
	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevParsed = HooksSliceSchema.safeParse((read.settings.hooks ?? {}) as unknown);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;
	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));
	const groups = nextSlice[input.event];
	if (!groups || groups.length <= input.groupIndex || !groups[input.groupIndex]) {
		return { ok: false, status: 404, error: `No matcher group at ${input.event}[${input.groupIndex}]` };
	}
	const group = groups[input.groupIndex];
	const previousMatcher = group.matcher;
	if (!group.hooks || group.hooks.length <= input.hookIndex) {
		return {
			ok: false,
			status: 404,
			error: `No hook at ${input.event}[${input.groupIndex}].hooks[${input.hookIndex}]`,
		};
	}
	const previousHookType = group.hooks[input.hookIndex]?.type;

	group.hooks.splice(input.hookIndex, 1);
	if (group.hooks.length === 0) {
		groups.splice(input.groupIndex, 1);
	}
	if (groups.length === 0) {
		delete nextSlice[input.event];
	}

	// Belt-and-suspenders: the on-disk slice was validated at read time
	// and the delete cannot introduce new shapes, but we still parse the
	// mutated slice before writing so the invariant holds uniformly
	// across install, update, relocate, and uninstall.
	const validated = HooksSliceSchema.safeParse(nextSlice);
	if (!validated.success) {
		return {
			ok: false,
			status: 422,
			error: `Hook validation failed after uninstall: ${validated.error.issues[0].message}`,
		};
	}

	const merged = { ...read.settings, hooks: validated.data };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) return { ok: false, status: 500, error: write.error };

	return { ok: true, slice: validated.data, previousSlice, previousMatcher, previousHookType };
}
