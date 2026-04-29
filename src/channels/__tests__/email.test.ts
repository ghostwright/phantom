import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EmailChannel, type EmailChannelConfig } from "../email.ts";

// Mock ImapFlow and Nodemailer
const mockConnect = mock(() => Promise.resolve());
const mockLogout = mock(() => Promise.resolve());
const mockGetMailboxLock = mock(() => Promise.resolve({ release: () => {} }));
const mockIdle = mock(
	(opts?: { abort?: AbortSignal }) =>
		new Promise<void>((_resolve, reject) => {
			if (opts?.abort) {
				if (opts.abort.aborted) {
					reject(new Error("abort"));
					return;
				}
				opts.abort.addEventListener("abort", () => reject(new Error("abort")), { once: true });
			}
		}),
);
const mockFetch = mock(function* () {
	// Empty generator - no unread messages
});
const mockMessageFlagsAdd = mock(() => Promise.resolve());
const mockSendMail = mock(() => Promise.resolve({ messageId: "<test@phantom.local>" }));

const MockImapFlow = mock((_opts: Record<string, unknown>) => ({
	connect: mockConnect,
	logout: mockLogout,
	getMailboxLock: mockGetMailboxLock,
	idle: mockIdle,
	fetch: mockFetch,
	messageFlagsAdd: mockMessageFlagsAdd,
}));

const mockCreateTransport = mock((_opts: Record<string, unknown>) => ({
	sendMail: mockSendMail,
}));

mock.module("imapflow", () => ({
	ImapFlow: MockImapFlow,
}));

mock.module("nodemailer", () => ({
	createTransport: mockCreateTransport,
	default: {
		createTransport: mockCreateTransport,
	},
}));

const testConfig: EmailChannelConfig = {
	imap: {
		host: "imap.test.com",
		port: 993,
		auth: { user: "test@test.com", pass: "password" },
		tls: true,
	},
	smtp: {
		host: "smtp.test.com",
		port: 587,
		auth: { user: "test@test.com", pass: "password" },
		tls: false,
	},
	fromAddress: "phantom@test.com",
	fromName: "Phantom",
};

describe("EmailChannel", () => {
	beforeEach(() => {
		mockConnect.mockClear();
		mockLogout.mockClear();
		mockSendMail.mockClear();
		mockGetMailboxLock.mockClear();
	});

	test("has correct id and capabilities", () => {
		const channel = new EmailChannel(testConfig);
		expect(channel.id).toBe("email");
		expect(channel.name).toBe("Email");
		expect(channel.capabilities.threads).toBe(true);
		expect(channel.capabilities.richText).toBe(true);
		expect(channel.capabilities.buttons).toBe(false);
	});

	test("starts disconnected", () => {
		const channel = new EmailChannel(testConfig);
		expect(channel.isConnected()).toBe(false);
	});

	test("connect transitions to connected", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(mockConnect).toHaveBeenCalledTimes(1);
	});

	test("disconnect transitions to disconnected", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
		expect(mockLogout).toHaveBeenCalledTimes(1);
	});

	test("send calls SMTP sendMail", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		const result = await channel.send("email:user@test.com:Bug fix", {
			text: "I fixed the bug in auth.ts.",
		});

		expect(result.channelId).toBe("email");
		expect(mockSendMail).toHaveBeenCalledTimes(1);
	});

	test("send includes correct from address", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		await channel.send("email:user@test.com:Subject", {
			text: "Test response",
		});

		const callArgs = (mockSendMail.mock.calls as unknown as Array<Array<Record<string, unknown>>>)[0][0];
		expect(callArgs.from).toContain("phantom@test.com");
		expect(callArgs.from).toContain("Phantom");
	});

	test("send generates HTML body", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		await channel.send("email:user@test.com:Subject", {
			text: "Hello world",
		});

		const callArgs = (mockSendMail.mock.calls as unknown as Array<Array<Record<string, unknown>>>)[0][0];
		const html = callArgs.html as string;
		expect(html).toContain("Hello world");
		expect(html).toContain("<div");
	});

	test("send includes plain text fallback", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		await channel.send("email:user@test.com:Subject", {
			text: "Plain text content",
		});

		const callArgs = (mockSendMail.mock.calls as unknown as Array<Array<Record<string, unknown>>>)[0][0];
		expect(callArgs.text).toBe("Plain text content");
	});

	test("disconnect awaits IDLE loop before logout", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		// disconnect should complete without hanging — the IDLE loop
		// must terminate before logout is called
		await channel.disconnect();

		// Verify logout was called (meaning IDLE loop finished first)
		expect(mockLogout).toHaveBeenCalledTimes(1);
		expect(channel.isConnected()).toBe(false);
	});

	test("rapid disconnect and reconnect does not leak IDLE loops", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		await channel.disconnect();
		mockGetMailboxLock.mockClear();

		// Reconnect should work cleanly without competing for the lock
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(mockGetMailboxLock).toHaveBeenCalledTimes(1);

		await channel.disconnect();
	});

	test("send generates unique message ID", async () => {
		const channel = new EmailChannel(testConfig);
		await channel.connect();

		await channel.send("email:user@test.com:Subject", { text: "First" });
		await channel.send("email:user@test.com:Subject", { text: "Second" });

		const calls = mockSendMail.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
		const id1 = calls[0][0].messageId;
		const id2 = calls[1][0].messageId;
		expect(id1).not.toBe(id2);
	});
});
