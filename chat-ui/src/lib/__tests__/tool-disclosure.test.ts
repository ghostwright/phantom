import { describe, expect, it } from "vitest";
import { initialToolDisclosureState, reconcileToolDisclosureState, toggleToolDisclosure } from "../tool-disclosure";

describe("tool disclosure policy", () => {
	it("starts successful completed tools collapsed", () => {
		expect(initialToolDisclosureState("result")).toMatchObject({
			isOpen: false,
			lastToolState: "result",
			userInteracted: false,
		});
	});

	it("starts routine tool states collapsed", () => {
		for (const state of ["pending", "input_streaming", "input_complete", "running"] as const) {
			expect(initialToolDisclosureState(state)).toMatchObject({
				isOpen: false,
				lastToolState: state,
				userInteracted: false,
			});
		}
	});

	it("starts blocked and errored tools open", () => {
		expect(initialToolDisclosureState("blocked").isOpen).toBe(true);
		expect(initialToolDisclosureState("error").isOpen).toBe(true);
	});

	it("closes an auto-open attention card after it resolves successfully", () => {
		const initial = initialToolDisclosureState("error");
		const next = reconcileToolDisclosureState(initial, "result");

		expect(next).toMatchObject({
			isOpen: false,
			lastToolState: "result",
			userInteracted: false,
		});
	});

	it("keeps untouched running tools collapsed after completion", () => {
		const initial = initialToolDisclosureState("running");
		const next = reconcileToolDisclosureState(initial, "result");

		expect(next.isOpen).toBe(false);
		expect(next.lastToolState).toBe("result");
	});

	it("preserves an explicit user expansion through completion", () => {
		const initial = initialToolDisclosureState("running");
		const opened = toggleToolDisclosure(initial);
		const next = reconcileToolDisclosureState(opened, "result");

		expect(next).toMatchObject({
			isOpen: true,
			lastToolState: "result",
			userInteracted: true,
		});
	});

	it("does not override a user-opened completed tool on same-state reconciliation", () => {
		const initial = initialToolDisclosureState("result");
		const opened = toggleToolDisclosure(initial);
		const next = reconcileToolDisclosureState(opened, "result");

		expect(next).toEqual(opened);
	});
});
