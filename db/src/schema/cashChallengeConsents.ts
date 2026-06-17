import { pgTable, text, integer, timestamp, uuid, unique } from "drizzle-orm/pg-core";

export const cashChallengeConsentsTable = pgTable(
  "cash_challenge_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    challengeId: uuid("challenge_id").notNull(),
    entryFeeCents: integer("entry_fee_cents").notNull(),
    currencyCode: text("currency_code").notNull().default("USD"),
    rulesVersion: text("rules_version").notNull(),
    acceptedAt: timestamp("accepted_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueConsent: unique("cash_challenge_consents_user_challenge_version_uniq").on(
      t.userId,
      t.challengeId,
      t.rulesVersion,
    ),
  }),
);
