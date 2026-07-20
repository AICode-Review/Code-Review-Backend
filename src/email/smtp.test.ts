import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn((_options: unknown) => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (options: unknown) => createTransportMock(options) },
}));

const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "EMAIL_FROM"] as const;
const ORIGINAL_ENV = Object.fromEntries(SMTP_ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of SMTP_ENV_KEYS) delete process.env[k];
  vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read per test.
  sendMailMock.mockReset();
  createTransportMock.mockClear();
});
afterEach(() => {
  for (const k of SMTP_ENV_KEYS) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function freshEmailModule() {
  return import("./smtp.js");
}

const MESSAGE = { to: "new-hire@acme.dev", subject: "You're invited", html: "<p>hi</p>", text: "hi" };

describe("emailConfigured", () => {
  it("is false with no SMTP settings", async () => {
    const { emailConfigured } = await freshEmailModule();
    expect(emailConfigured()).toBe(false);
  });

  it("is false when only some of host/user/pass are set", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    const { emailConfigured } = await freshEmailModule();
    expect(emailConfigured()).toBe(false);
  });

  it("is true once host, user, and pass are all set", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_USER"] = "user@example.com";
    process.env["SMTP_PASS"] = "secret";
    const { emailConfigured } = await freshEmailModule();
    expect(emailConfigured()).toBe(true);
  });
});

describe("sendEmail", () => {
  it("never builds a transport when unconfigured", async () => {
    const { sendEmail } = await freshEmailModule();

    const result = await sendEmail(MESSAGE);

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/SMTP is not configured/);
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("sends via nodemailer with the configured transport and message, reports success", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_PORT"] = "587";
    process.env["SMTP_USER"] = "user@example.com";
    process.env["SMTP_PASS"] = "secret";
    sendMailMock.mockResolvedValue({ messageId: "abc" });
    const { sendEmail } = await freshEmailModule();

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ sent: true });
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "user@example.com", pass: "secret" },
      }),
    );
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: MESSAGE.to, subject: MESSAGE.subject, html: MESSAGE.html, text: MESSAGE.text }),
    );
  });

  it("defaults secure:true when SMTP_SECURE is set", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_USER"] = "user@example.com";
    process.env["SMTP_PASS"] = "secret";
    process.env["SMTP_SECURE"] = "true";
    sendMailMock.mockResolvedValue({});
    const { sendEmail } = await freshEmailModule();

    await sendEmail(MESSAGE);

    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it("degrades to sent:false when nodemailer rejects — never throws", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_USER"] = "user@example.com";
    process.env["SMTP_PASS"] = "secret";
    sendMailMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { sendEmail } = await freshEmailModule();

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ sent: false, error: "ECONNREFUSED" });
  });

  it("degrades to sent:false when createTransport itself throws (e.g. bad config) — never throws", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_USER"] = "user@example.com";
    process.env["SMTP_PASS"] = "secret";
    createTransportMock.mockImplementationOnce(() => {
      throw new Error("invalid host");
    });
    const { sendEmail } = await freshEmailModule();

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ sent: false, error: "invalid host" });
  });
});
