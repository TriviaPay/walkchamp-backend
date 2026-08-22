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

export type AccountDeletionEmailProvider = "resend";

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
 * Sends an account-deletion request to the admin mailbox through the server-side mail provider.
 * Account identifiers must never be submitted from the browser directly to a third-party form
 * relay; only the backend holds this credential and performs delivery.
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
    if (!resendApiKey) throw new Error("Account-deletion email is not configured");

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
