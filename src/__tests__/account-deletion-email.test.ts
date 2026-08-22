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

  it("refuses to send account identifiers when the mail provider is not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(sendAccountDeletionRequestEmail(request, {
      fetchImpl,
      resendApiKey: null,
    })).rejects.toThrow("not configured");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the mail provider does not accept the request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));

    await expect(sendAccountDeletionRequestEmail(request, {
      fetchImpl,
      resendApiKey: "resend-test-key",
    })).rejects.toThrow("Resend rejected");
  });
});
