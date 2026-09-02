export const STREAK_CHALLENGE_API_BASE = "/streak-challenges";
export const LEGACY_STREAK_CHALLENGE_API_BASE = "/unlimited-challenges";
export const STREAK_CHALLENGE_ADMIN_API_BASE = "/admin/streak-challenges";
export const LEGACY_STREAK_CHALLENGE_ADMIN_API_BASE = "/admin/unlimited-challenges";
export const STREAK_CHALLENGE_KIND = "streak_challenge" as const;
// Persisted/client discriminator retained so older app builds continue recognizing these rows.
export const LEGACY_STREAK_CHALLENGE_TYPE = "unlimited_goal" as const;

function rewriteAtBoundary(url: string, legacyBase: string, canonicalBase: string): string {
  if (url === legacyBase || url.startsWith(`${legacyBase}/`) || url.startsWith(`${legacyBase}?`)) {
    return `${canonicalBase}${url.slice(legacyBase.length)}`;
  }
  return url;
}

export function rewriteLegacyPublicStreakChallengeUrl(url: string): string {
  return rewriteAtBoundary(url, LEGACY_STREAK_CHALLENGE_API_BASE, STREAK_CHALLENGE_API_BASE);
}

export function rewriteLegacyAdminStreakChallengeUrl(url: string): string {
  return rewriteAtBoundary(url, LEGACY_STREAK_CHALLENGE_ADMIN_API_BASE, STREAK_CHALLENGE_ADMIN_API_BASE);
}

/**
 * Rewrites legacy public/admin paths to the canonical Streak Challenge API.
 * Query strings are preserved, and similarly-prefixed unrelated paths are untouched.
 */
export function rewriteLegacyStreakChallengeUrl(url: string): string {
  return rewriteLegacyPublicStreakChallengeUrl(rewriteLegacyAdminStreakChallengeUrl(url));
}
