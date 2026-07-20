import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateInviteCode, generateReferralCode } from "../lib/inviteCodes.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// H-8: invite / referral codes must be CSPRNG-backed, unbiased, and high-entropy.
describe("invite code generation (H-8)", () => {
  it("produces codes of the requested length from the safe alphabet", () => {
    const code = generateInviteCode();
    expect(code.length).toBe(13);
    for (const ch of code) expect(ALPHABET).toContain(ch);

    const short = generateInviteCode(8);
    expect(short.length).toBe(8);
  });

  it("excludes visually ambiguous characters (no I/O/0/1)", () => {
    const blob = Array.from({ length: 500 }, () => generateInviteCode()).join("");
    for (const bad of ["I", "O", "0", "1"]) expect(blob).not.toContain(bad);
  });

  it("is effectively collision-free across many draws (high entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateInviteCode());
    expect(seen.size).toBe(5000);
  });

  it("is close to uniform across the alphabet (no modulo bias)", () => {
    const counts: Record<string, number> = {};
    const blob = Array.from({ length: 4000 }, () => generateInviteCode()).join("");
    for (const ch of blob) counts[ch] = (counts[ch] ?? 0) + 1;
    // Every symbol should appear; none should dominate (bias would starve some).
    expect(Object.keys(counts).length).toBe(ALPHABET.length);
    const expected = blob.length / ALPHABET.length;
    for (const ch of ALPHABET) {
      expect(counts[ch]).toBeGreaterThan(expected * 0.6);
      expect(counts[ch]).toBeLessThan(expected * 1.4);
    }
  });

  it("referral codes carry the WC prefix and a secure body", () => {
    const ref = generateReferralCode();
    expect(ref.startsWith("WC")).toBe(true);
    expect(ref.length).toBe(14);
  });

  it("never uses Math.random for codes in the code paths that generate them", () => {
    for (const file of ["src/lib/inviteCodes.ts", "src/routes/groups.ts", "src/routes/auth.ts", "src/routes/races.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("Math.random().toString(36)");
    }
  });
});
