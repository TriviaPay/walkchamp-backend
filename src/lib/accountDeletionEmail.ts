const DEFAULT_ADMIN_EMAIL = "admin@miragaming.com";
const DEFAULT_RESEND_FROM = "WalkChamp <no-reply@miragaming.com>";
const EMAIL_TIMEOUT_MS = 8_000;

export type AccountDeletionEmailInput = {
  source: "authenticated_app" | "public_web_form";
  userId?: string | null;
  username?: string | null;
  email: string;
  fullName?: string | null;
  notes?: string | null;
  requestedAt: Date;
};

export type AccountDeletionEmailProvider = "resend" | "formsubmit";

type SendOptions = {
  fetchImpl?: typeof fetch;
  resendApiKey?: string | null;
  from?: string;
  to?: string;
};

function accountDeletionMessage(input: AccountDeletionEmailInput): string {
  return [
    input.source === "authenticated_app"
      ? "A WalkChamp user requested account deletion from the authenticated app."
      : "A user submitted an account deletion request from www.miragaming.com/walkchamp/delete-account. The identity has not yet been verified.",
    "",
    `Name: ${input.fullName || "Not provided"}`,
    `Username: ${input.username || "Not provided"}`,
    `Registered email: ${input.email}`,
    `User ID: ${input.userId || "Not available"}`,
    `Notes: ${input.notes || "Not provided"}`,
    `Requested at: ${input.requestedAt.toISOString()}`,
    "",
    "Please review and process this request according to the account-deletion procedure.",
  ].join("\n");
}

/**
 * Sends an account-deletion request to the admin mailbox. Resend is preferred when configured;
 * otherwise this uses the same FormSubmit relay approved for the Mira Gaming website.
 */
export async function sendAccountDeletionRequestEmail(
  input: AccountDeletionEmailInput,
  options: SendOptions = {},
): Promise<AccountDeletionEmailProvider> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resendApiKey = options.resendApiKey ?? process.env.RESEND_API_KEY?.trim() ?? null;
  const to = options.to?.trim() || process.env.ACCOUNT_DELETION_EMAIL_TO?.trim() || DEFAULT_ADMIN_EMAIL;
  const from = options.from?.trim() || process.env.RESEND_EMAIL_FROM?.trim() || DEFAULT_RESEND_FROM;
  const subject = `WalkChamp account deletion request — ${input.username || input.email}`;
  const text = accountDeletionMessage(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);

  try {
    if (!resendApiKey) {
      const response = await fetchImpl(`https://formsubmit.co/ajax/${to}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name: input.fullName || "WalkChamp user",
          email: input.email,
          username: input.username || "Not provided",
          notes: input.notes || "Not provided",
          message: text,
          request_type: "WalkChamp account deletion",
          _subject: subject,
          _template: "table",
          _captcha: "false",
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`FormSubmit rejected account-deletion email (${response.status})`);
      const result = await response.json() as { success?: string | boolean };
      if (result.success !== "true" && result.success !== true) {
        throw new Error("FormSubmit did not accept account-deletion email");
      }
      return "formsubmit";
    }

    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], reply_to: input.email, subject, text }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Resend rejected account-deletion email (${response.status})`);
    return "resend";
  } finally {
    clearTimeout(timeout);
  }
}
