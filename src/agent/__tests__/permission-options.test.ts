// Tests for the permissions-to-SDK-options mapper. This is the glue that
// closes the "permissions section is inert" gap flagged in PR 6 review:
// PhantomConfig.permissions values flow through here into every query()
// options object, so runtime + chat-query both honor the operator's
// dashboard selection on the next message.

import { describe, expect, test } from "bun:test";
import type { PhantomConfig } from "../../config/types.ts";
import { permissionOptionsFromConfig } from "../permission-options.ts";

function makeConfig(overrides: Partial<PhantomConfig["permissions"] | undefined> = {}): PhantomConfig {
	return {
		permissions: {
			default_mode: "bypassPermissions",
			allow: [],
			deny: [],
			...overrides,
		},
	} as PhantomConfig;
}

describe("permissionOptionsFromConfig", () => {
	test("missing permissions block defaults to bypassPermissions with skip flag on", () => {
		const opts = permissionOptionsFromConfig({} as PhantomConfig);
		expect(opts.permissionMode).toBe("bypassPermissions");
		expect(opts.allowDangerouslySkipPermissions).toBe(true);
		expect(opts.allowedTools).toBeUndefined();
		expect(opts.disallowedTools).toBeUndefined();
	});

	test("bypassPermissions sets the skip flag", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ default_mode: "bypassPermissions" }));
		expect(opts.permissionMode).toBe("bypassPermissions");
		expect(opts.allowDangerouslySkipPermissions).toBe(true);
	});

	test("acceptEdits does NOT set the skip flag", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ default_mode: "acceptEdits" }));
		expect(opts.permissionMode).toBe("acceptEdits");
		expect(opts.allowDangerouslySkipPermissions).toBe(false);
	});

	test("default mode does NOT set the skip flag", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ default_mode: "default" }));
		expect(opts.permissionMode).toBe("default");
		expect(opts.allowDangerouslySkipPermissions).toBe(false);
	});

	test("allow list is passed through as allowedTools when non-empty", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ allow: ["Bash", "Read"] }));
		expect(opts.allowedTools).toEqual(["Bash", "Read"]);
	});

	test("empty allow list yields no allowedTools key", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ allow: [] }));
		expect(opts.allowedTools).toBeUndefined();
	});

	test("deny list is passed through as disallowedTools when non-empty", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ deny: ["WebFetch"] }));
		expect(opts.disallowedTools).toEqual(["WebFetch"]);
	});

	test("empty deny list yields no disallowedTools key", () => {
		const opts = permissionOptionsFromConfig(makeConfig({ deny: [] }));
		expect(opts.disallowedTools).toBeUndefined();
	});

	test("returned allow/deny are copies, not the same reference", () => {
		const config = makeConfig({ allow: ["Bash"], deny: ["WebFetch"] });
		const opts = permissionOptionsFromConfig(config);
		expect(opts.allowedTools).not.toBe(config.permissions?.allow);
		expect(opts.disallowedTools).not.toBe(config.permissions?.deny);
	});
});
