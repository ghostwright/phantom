import { describe, expect, test } from "bun:test";
import promClient from "prom-client";
import { EMAIL_SEND_OUTCOMES, EmailMetrics, NoopEmailMetrics, sanitizePurpose } from "../metrics.ts";

describe("EmailMetrics", () => {
	test("registers phantom_email_send_total with the right labels", async () => {
		const registry = new promClient.Registry();
		new EmailMetrics(registry);
		const text = await registry.metrics();
		expect(text).toContain("phantom_email_send_total");
		expect(text).toContain("# HELP phantom_email_send_total");
		expect(text).toContain("# TYPE phantom_email_send_total counter");
	});

	test("records ok outcome and increments the counter", async () => {
		const registry = new promClient.Registry();
		const metrics = new EmailMetrics(registry);
		metrics.recordSend("ok", "agent_ping_user");
		metrics.recordSend("ok", "agent_ping_user");
		const text = await registry.metrics();
		// Two sends with the same labels yield 2.0
		expect(text).toMatch(/phantom_email_send_total\{outcome="ok",purpose="agent_ping_user"\} 2/);
	});

	test("records every error_kind outcome distinctly", async () => {
		const registry = new promClient.Registry();
		const metrics = new EmailMetrics(registry);
		for (const outcome of EMAIL_SEND_OUTCOMES) {
			metrics.recordSend(outcome, "test");
		}
		const text = await registry.metrics();
		for (const outcome of EMAIL_SEND_OUTCOMES) {
			expect(text).toMatch(new RegExp(`phantom_email_send_total\\{outcome="${outcome}",purpose="test"\\} 1`));
		}
	});

	test("zero-state matrix is emitted at construction (alerts do not flap on cold boot)", async () => {
		const registry = new promClient.Registry();
		new EmailMetrics(registry);
		const text = await registry.metrics();
		for (const outcome of EMAIL_SEND_OUTCOMES) {
			expect(text).toMatch(new RegExp(`phantom_email_send_total\\{outcome="${outcome}",purpose="unspecified"\\} 0`));
		}
	});
});

describe("NoopEmailMetrics", () => {
	test("recordSend is a no-op (no throws)", () => {
		const metrics = new NoopEmailMetrics();
		expect(() => metrics.recordSend("ok", "x")).not.toThrow();
	});
});

describe("sanitizePurpose", () => {
	test("returns 'unspecified' for empty / undefined", () => {
		expect(sanitizePurpose(undefined)).toBe("unspecified");
		expect(sanitizePurpose("")).toBe("unspecified");
		expect(sanitizePurpose("   ")).toBe("unspecified");
	});

	test("passes through valid ASCII labels", () => {
		expect(sanitizePurpose("agent_ping_user")).toBe("agent_ping_user");
		expect(sanitizePurpose("intro-dm")).toBe("intro-dm");
		expect(sanitizePurpose("daily_summary")).toBe("daily_summary");
	});

	test("returns 'unknown' for non-ASCII / invalid characters (cardinality bound)", () => {
		expect(sanitizePurpose("hello world")).toBe("unknown");
		expect(sanitizePurpose("foo:bar")).toBe("unknown");
		expect(sanitizePurpose("🤖")).toBe("unknown");
	});

	test("rejects label longer than 50 chars", () => {
		expect(sanitizePurpose("a".repeat(51))).toBe("unknown");
		expect(sanitizePurpose("a".repeat(50))).toBe("a".repeat(50));
	});
});
