import { describe, expect, test } from "bun:test";
import { isSafeCallbackUrl } from "../url-validator.ts";

describe("isSafeCallbackUrl", () => {
	test("allows public HTTPS URLs", () => {
		expect(isSafeCallbackUrl("https://example.com/webhook")).toEqual({ safe: true });
		expect(isSafeCallbackUrl("https://api.zapier.com/callback")).toEqual({ safe: true });
		expect(isSafeCallbackUrl("https://hooks.slack.com/services/T00000000/B00000000/xxxx")).toEqual({ safe: true });
	});

	test("allows public HTTP URLs", () => {
		expect(isSafeCallbackUrl("http://example.com/webhook")).toEqual({ safe: true });
	});

	test("blocks localhost", () => {
		expect(isSafeCallbackUrl("http://localhost:6333")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://127.0.0.1:6333")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://0.0.0.0:3100")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://[::1]:6333")).toMatchObject({ safe: false });
	});

	test("blocks private IP ranges - 10.x.x.x", () => {
		expect(isSafeCallbackUrl("http://10.0.0.1/secret")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://10.255.255.255/data")).toMatchObject({ safe: false });
	});

	test("blocks private IP ranges - 172.16-31.x.x", () => {
		expect(isSafeCallbackUrl("http://172.16.0.1/internal")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://172.31.255.255/internal")).toMatchObject({ safe: false });
	});

	test("allows non-private 172.x ranges", () => {
		expect(isSafeCallbackUrl("http://172.15.0.1/ok")).toEqual({ safe: true });
		expect(isSafeCallbackUrl("http://172.32.0.1/ok")).toEqual({ safe: true });
	});

	test("blocks private IP ranges - 192.168.x.x", () => {
		expect(isSafeCallbackUrl("http://192.168.1.1/admin")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://192.168.0.1/router")).toMatchObject({ safe: false });
	});

	test("blocks cloud metadata endpoints via IP", () => {
		expect(isSafeCallbackUrl("http://169.254.169.254/latest/meta-data")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://169.254.169.254/computeMetadata/v1")).toMatchObject({ safe: false });
	});

	test("blocks cloud metadata endpoints via hostname", () => {
		expect(isSafeCallbackUrl("http://metadata.google.internal/computeMetadata/v1")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://metadata.google.com/computeMetadata/v1")).toMatchObject({ safe: false });
	});

	test("blocks non-HTTP protocols", () => {
		expect(isSafeCallbackUrl("ftp://example.com")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("file:///etc/passwd")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("javascript:alert(1)")).toMatchObject({ safe: false });
	});

	test("rejects invalid URLs", () => {
		expect(isSafeCallbackUrl("not-a-url")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("://missing-protocol")).toMatchObject({ safe: false });
	});

	test("blocks 127.x.x.x loopback range", () => {
		expect(isSafeCallbackUrl("http://127.0.0.2:8080")).toMatchObject({ safe: false });
		expect(isSafeCallbackUrl("http://127.255.255.255")).toMatchObject({ safe: false });
	});

	test("blocks IPv4-mapped IPv6 loopback", () => {
		expect(isSafeCallbackUrl("http://[::ffff:127.0.0.1]:6333")).toMatchObject({ safe: false });
	});

	test("blocks IPv4-mapped IPv6 cloud metadata", () => {
		expect(isSafeCallbackUrl("http://[::ffff:169.254.169.254]/meta")).toMatchObject({ safe: false });
	});

	test("blocks IPv4-mapped IPv6 private 10.x.x.x", () => {
		expect(isSafeCallbackUrl("http://[::ffff:10.0.0.1]/internal")).toMatchObject({ safe: false });
	});

	test("blocks IPv4-mapped IPv6 private 192.168.x.x", () => {
		expect(isSafeCallbackUrl("http://[::ffff:192.168.1.1]/admin")).toMatchObject({ safe: false });
	});

	test("blocks bare IPv6 loopback", () => {
		expect(isSafeCallbackUrl("http://[::1]")).toMatchObject({ safe: false });
	});

	test("allows IPv4-mapped IPv6 with public IP", () => {
		expect(isSafeCallbackUrl("http://[::ffff:8.8.8.8]")).toEqual({ safe: true });
	});

	test("still allows regular public hostname", () => {
		expect(isSafeCallbackUrl("http://example.com")).toEqual({ safe: true });
	});

	test("still allows regular public IPv4", () => {
		expect(isSafeCallbackUrl("http://8.8.8.8")).toEqual({ safe: true });
	});

	// IPv4-compatible and ISATAP bypass forms (found during adversarial review)
	test("blocks IPv4-compatible loopback (::7f00:1)", () => {
		expect(isSafeCallbackUrl("http://[::7f00:1]:6333")).toMatchObject({ safe: false });
	});

	test("blocks IPv4-compatible private 10.x (::a00:1)", () => {
		expect(isSafeCallbackUrl("http://[::a00:1]:6333")).toMatchObject({ safe: false });
	});

	test("blocks IPv4-compatible metadata (::a9fe:fea9)", () => {
		expect(isSafeCallbackUrl("http://[::a9fe:fea9]:6333")).toMatchObject({ safe: false });
	});

	test("blocks ISATAP form loopback (::ffff:0:7f00:1)", () => {
		expect(isSafeCallbackUrl("http://[::ffff:0:7f00:1]:6333")).toMatchObject({ safe: false });
	});

	test("allows IPv4-compatible with public IP", () => {
		expect(isSafeCallbackUrl("http://[::ffff:8.8.8.8]")).toEqual({ safe: true });
	});
});
