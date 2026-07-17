import { pgEnum, pgTable, text, integer, timestamp, jsonb, index, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { profilesTable } from "./profiles.js";
import { raceRoomsTable } from "./races.js";

export const sponsoredGiftCardAwardStatusEnum = pgEnum("sponsored_gift_card_award_status", [
  "pending_fulfillment",
  "fulfilled",
  "cancelled",
]);

export const sponsoredGiftCardAwardsTable = pgTable(
  "sponsored_gift_card_awards",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    raceRoomId: uuid("race_room_id")
      .notNull()
      .references(() => raceRoomsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => profilesTable.id, { onDelete: "restrict" }),
    prizeAmountCents: integer("prize_amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    provider: text("provider").notNull().default("amazon"),
    status: sponsoredGiftCardAwardStatusEnum("status").notNull().default("pending_fulfillment"),
    recipientEmail: text("recipient_email"),
    fulfillmentReference: text("fulfillment_reference"),
    fulfillmentCode: text("fulfillment_code"),
    fulfillmentNotes: text("fulfillment_notes"),
    fulfilledBy: text("fulfilled_by"),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sponsored_gift_card_awards_room_user_uniq").on(t.raceRoomId, t.userId),
    index("sponsored_gift_card_awards_status_idx").on(t.status),
    index("sponsored_gift_card_awards_user_idx").on(t.userId),
  ],
);

export const insertSponsoredGiftCardAwardSchema = createInsertSchema(sponsoredGiftCardAwardsTable).omit({
  id: true,
  status: true,
  fulfilledAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
});
export const selectSponsoredGiftCardAwardSchema = createSelectSchema(sponsoredGiftCardAwardsTable);

export type SponsoredGiftCardAward = typeof sponsoredGiftCardAwardsTable.$inferSelect;
export type InsertSponsoredGiftCardAward = z.infer<typeof insertSponsoredGiftCardAwardSchema>;
