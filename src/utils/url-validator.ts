import { isIP } from "node:net";

type ValidationResult = { safe: boolean; reason?: string };

/**
 * Validate that a URL is safe for server-side requests (SSRF prevention).
 * Blocks private IPs, localhost, cloud metadata endpoints, and link-local addresses.
 */
export function isSafeCallbackUrl(url: string): ValidationResult {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { safe: false, reason: "Invalid URL" };
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
	}

	const hostname = parsed.hostname.toLowerCase();

	// Strip brackets from IPv6 addresses so isIP() recognizes them
	const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

	// Block localhost variants
	if (
		bareHost === "localhost" ||
		bareHost === "127.0.0.1" ||
		bareHost === "::1" ||
		bareHost === "0.0.0.0" ||
		hostname === "[::1]"
	) {
		return { safe: false, reason: "Localhost addresses are not allowed" };
	}

	// Block link-local (169.254.x.x) - covers cloud metadata endpoint 169.254.169.254
	if (bareHost.startsWith("169.254.")) {
		return { safe: false, reason: "Link-local addresses are not allowed" };
	}

	// Block well-known cloud metadata endpoints by hostname
	if (bareHost === "metadata.google.internal" || bareHost === "metadata.google.com") {
		return { safe: false, reason: "Cloud metadata endpoints are not allowed" };
	}

	// Check if hostname is an IP address and block private ranges
	const ipVersion = isIP(bareHost);
	if (ipVersion > 0) {
		if (isPrivateIp(bareHost)) {
			return { safe: false, reason: "Private IP addresses are not allowed" };
		}
	}

	return { safe: true };
}

function isPrivateIp(ip: string): boolean {
	// Extract IPv4 from mapped IPv6 (::ffff:x.x.x.x)
	const mappedDotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mappedDotted) return isPrivateIp(mappedDotted[1]);

	// Extract IPv4 from hex-form mapped IPv6 (::ffff:7f00:1)
	const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (mappedHex) {
		const hi = Number.parseInt(mappedHex[1], 16);
		const lo = Number.parseInt(mappedHex[2], 16);
		const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
		return isPrivateIp(dotted);
	}

	// IPv4-compatible addresses (::HHHH:HHHH without ffff prefix, deprecated but parseable)
	const compatHex = ip.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (compatHex) {
		const hi = Number.parseInt(compatHex[1], 16);
		const lo = Number.parseInt(compatHex[2], 16);
		const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
		return isPrivateIp(dotted);
	}

	// ISATAP form (::ffff:0:HHHH:HHHH)
	const isatapHex = ip.match(/^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (isatapHex) {
		const hi = Number.parseInt(isatapHex[1], 16);
		const lo = Number.parseInt(isatapHex[2], 16);
		const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
		return isPrivateIp(dotted);
	}

	const parts = ip.split(".").map(Number);
	if (parts.length === 4 && parts.every((p) => !Number.isNaN(p))) {
		// 10.0.0.0/8
		if (parts[0] === 10) return true;
		// 172.16.0.0/12
		if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
		// 192.168.0.0/16
		if (parts[0] === 192 && parts[1] === 168) return true;
		// 127.0.0.0/8 (loopback)
		if (parts[0] === 127) return true;
		// 169.254.0.0/16 (link-local, including cloud metadata)
		if (parts[0] === 169 && parts[1] === 254) return true;
		// 0.0.0.0/8
		if (parts[0] === 0) return true;
	}

	// IPv6 private ranges
	const lower = ip.toLowerCase();
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // Unique local
	if (lower.startsWith("fe80")) return true; // Link-local
	if (lower === "::1") return true; // Loopback

	return false;
}
