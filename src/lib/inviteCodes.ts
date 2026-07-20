import { randomBytes } from "node:crypto";

// Single source of truth for all invite / referral / room codes.
//
// Uses a CSPRNG (crypto.randomBytes) with rejection sampling over a 32-char
// Crockford-style alphabet (no I/O/0/1 to avoid visual ambiguity). Rejection
// sampling avoids the modulo bias that `byte % alphabet.length` introduces, so
// every character is uniformly distributed. Default 13 chars ≈ 65 bits of
// entropy — enough that enumeration of the code space is infeasible even with
// no rate limiting, though join-by-code endpoints are also rate limited.
//
// Never use Math.random() for codes: it is not cryptographically secure and its
// internal V8 state can be recovered from a few outputs, making codes predictable.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars

/**
 * Generate a uniformly-distributed, unpredictable code of `length` characters.
 * `length` 13 yields ~65 bits of entropy over the 32-char alphabet.
 */
export function generateInviteCode(length = 13): string {
  if (length <= 0) throw new Error("generateInviteCode: length must be positive");
  const out: string[] = [];
  // 256 is a multiple of 32, so every byte value maps cleanly with no bias.
  // We still draw in batches and only accept bytes < 256 (all of them) — the
  // rejection guard is kept for alphabets whose length does not divide 256.
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < length) {
    const bytes = randomBytes(length - out.length + 8);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      const b = bytes[i];
      if (b >= max) continue; // reject to keep the distribution uniform
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}

/** Referral codes: `WC` prefix + secure body (kept short but ≥60 bits). */
export function generateReferralCode(): string {
  return "WC" + generateInviteCode(12);
}
