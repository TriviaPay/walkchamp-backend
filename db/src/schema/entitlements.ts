import { pgTable, text, integer, timestamp, uuid, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

// ── User Entitlements ─────────────────────────────────────────────────────────
// Lifetime product unlocks stored in NeonDB.
// Backend is always the source of truth — never trust frontend entitlement alone.
// Current keys: 'mic_pass'
// Note: No FK to profiles — entitlements must work even before profile setup is complete.
export const userEntitlementsTable = pgTable(
  "user_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    entitlementKey: text("entitlement_key").notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("iap"),
    platform: text("platform"),
    productId: text("product_id"),
    purchaseToken: text("purchase_token"),
    transactionId: text("transaction_id"),
    purchasedAt: timestamp("purchased_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_entitlements_user_key_unique").on(t.userId, t.entitlementKey),
  ],
);

// ── User Purchases ────────────────────────────────────────────────────────────
// Raw purchase records from app stores (Apple / Google).
// productType: 'non_consumable' | 'consumable' | 'subscription'
// platform:    'ios' | 'android' | 'dev'
// Note: No FK to profiles — purchases must be recordable even before profile setup is complete.
export const userPurchasesTable = pgTable("user_purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull(),
  productType: text("product_type").notNull().default("non_consumable"),
  platform: text("platform").notNull(),
  amount: integer("amount"),
  currency: text("currency"),
  paymentProvider: text("payment_provider"),
  transactionId: text("transaction_id"),
  purchaseToken: text("purchase_token"),
  status: text("status").notNull().default("verified"),
  rawReceiptJson: jsonb("raw_receipt_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserEntitlement = typeof userEntitlementsTable.$inferSelect;
export type UserPurchase = typeof userPurchasesTable.$inferSelect;
