import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAccountDeletionRequestEmail } from "../lib/accountDeletionEmail.js";

const request = {
  source: "authenticated_app" as const,
  userId: "user-123",
  username: "walker123",
  email: "walker@example.com",
  fullName: "Test Walker",
  notes: "Please remove my account and associated profile data.",
  requestedAt: new Date("2026-08-22T12:00:00.000Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("account deletion request email", () => {
  it("uses the configured Resend account and addresses the admin mailbox", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(sendAccountDeletionRequestEmail(request, {
      fetchImpl,
      resendApiKey: "resend-test-key",
      from: "WalkChamp <requests@miragaming.com>",
    })).resolves.toBe("resend");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer resend-test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.to).toEqual(["admin@miragaming.com"]);
    expect(body.reply_to).toBe("walker@example.com");
    expect(body.text).toContain("Username: walker123");
    expect(body.text).toContain("Notes: Please remove my account and associated profile data.");
    expect(body.text).not.toContain("password");
  });

  it("uses the same FormSubmit fallback as the Mira Gaming contact form when Resend is not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"success":"true"}', { status: 200 }));

    await expect(sendAccountDeletionRequestEmail(request, {
      fetchImpl,
      resendApiKey: null,
    })).resolves.toBe("formsubmit");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://formsubmit.co/ajax/admin@miragaming.com");
    const body = JSON.parse(String(init?.body));
    expect(body.email).toBe("walker@example.com");
    expect(body.username).toBe("walker123");
    expect(body.notes).toBe("Please remove my account and associated profile data.");
    expect(body._captcha).toBe("false");
    expect(body._url).toBe("https://www.miragaming.com/walkchamp/delete-account");
  });

  it("fails when FormSubmit does not accept the request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"success":"false"}', { status: 200 }));

    await expect(sendAccountDeletionRequestEmail(request, {
      fetchImpl,
      resendApiKey: null,
    })).rejects.toThrow("did not accept");
  });

  it("fails when the mail provider does not accept the request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));

    await expect(sendAccountDeletionRequestEmail(request, {
      fetchImpl,
      resendApiKey: "resend-test-key",
    })).rejects.toThrow("Resend rejected");
  });
});
