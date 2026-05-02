// Unit tests for the env-based grant resolver. The runner depends on
// this module for the `available_integrations` set used to filter
// per-persona required integrations. Slack must always appear in the
// result (the wizard's slot 10 install completes before phantom boots
// per architect §6.1).

import { describe, expect, test } from "bun:test";
import { readGrantedIntegrations } from "../grants.ts";

describe("readGrantedIntegrations", () => {
	test("returns ['slack'] when env is empty", () => {
		expect(readGrantedIntegrations({ env: {} })).toEqual(["slack"]);
	});

	test("parses comma-separated values", () => {
		expect(readGrantedIntegrations({ env: { PHANTOM_GRANTED_INTEGRATIONS: "github,calendar" } })).toEqual([
			"slack",
			"github",
			"calendar",
		]);
	});

	test("lowercases and dedupes", () => {
		expect(readGrantedIntegrations({ env: { PHANTOM_GRANTED_INTEGRATIONS: "GitHub, github, GitHub" } })).toEqual([
			"slack",
			"github",
		]);
	});

	test("ignores whitespace-only entries", () => {
		expect(readGrantedIntegrations({ env: { PHANTOM_GRANTED_INTEGRATIONS: " , github , , calendar," } })).toEqual([
			"slack",
			"github",
			"calendar",
		]);
	});

	test("preserves order from env, with slack first", () => {
		expect(
			readGrantedIntegrations({
				env: { PHANTOM_GRANTED_INTEGRATIONS: "github,linear,calendar,slack" },
			}),
		).toEqual(["slack", "github", "linear", "calendar"]);
	});

	test("treats unset env exactly as empty string", () => {
		const out = readGrantedIntegrations({ env: { PHANTOM_GRANTED_INTEGRATIONS: undefined } });
		expect(out).toEqual(["slack"]);
	});
});
