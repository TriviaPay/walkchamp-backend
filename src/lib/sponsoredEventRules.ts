export const SPONSORED_EVENT_ENTRY_COINS = 5000;
export const SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS = 500;
export const SPONSORED_EVENT_TARGET_STEPS = 10000;
export const SPONSORED_EVENT_MAX_SLOTS = 10;

export function getSponsoredWinnerCount(playerCount: number): number {
  if (playerCount <= 0) return 0;
  return playerCount <= 2 ? 1 : 2;
}

export function getSponsoredPrizePoolCents(playerCount: number): number {
  return getSponsoredWinnerCount(playerCount) * SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS;
}
