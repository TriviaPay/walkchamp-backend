import { pgTable, text, boolean, timestamp, uuid } from "drizzle-orm/pg-core";

// ── Restricted Regions ────────────────────────────────────────────────────────
// Regions where paid challenges and/or withdrawals are not permitted.
// Backend enforces these rules — never trust frontend-only checks.
export const restrictedRegionsTable = pgTable("restricted_regions", {
  id: uuid("id").primaryKey().defaultRandom(),
  countryCode: text("country_code").notNull(),
  regionCode: text("region_code"),
  restrictionType: text("restriction_type").notNull().default("paid_races"),
  reason: text("reason"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type RestrictedRegion = typeof restrictedRegionsTable.$inferSelect;
