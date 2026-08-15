export const UNLIMITED_LEFT_STATUSES = ["left", "forfeited", "withdrawn", "quit"] as const;
export const UNLIMITED_NON_ACTIVE_STATUSES = [...UNLIMITED_LEFT_STATUSES] as const;
