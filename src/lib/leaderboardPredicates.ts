export const COINS_WON_REWARD_CODES = new Set([
  "PUBLIC_ROOM_WIN",
  "PRIVATE_ROOM_WIN",
]);

export function isRewardedRaceWinResult(row: { eligibleForPrize?: boolean | null }): boolean {
  return row.eligibleForPrize === true;
}

export function isCoinsWonRewardCode(rewardCode: string | null | undefined): boolean {
  if (!rewardCode) return false;
  return (
    rewardCode.startsWith("COINS_BATTLE_WIN_")
    || rewardCode.includes("_RACE_WIN_")
    || COINS_WON_REWARD_CODES.has(rewardCode)
  );
}
