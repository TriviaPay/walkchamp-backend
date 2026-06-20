import { pgTable, text, timestamp, boolean, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const chatReactionTypeEnum = pgEnum("chat_reaction_type", ["global", "private"]);

export const globalChatMessagesTable = pgTable(
  "global_chat_messages",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    username: text("username").notNull(),
    countryFlag: text("country_flag").notNull().default("🏳️"),
    avatarColor: text("avatar_color").notNull().default("#00E676"),
    text: text("text").notNull(),
    replyToId: text("reply_to_id"),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("global_chat_created_idx").on(t.createdAt),
    index("global_chat_user_idx").on(t.userId),
  ],
);

export const conversationsTable = pgTable(
  "conversations",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    user1Id: text("user1_id").notNull(),
    user2Id: text("user2_id").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_users_idx").on(t.user1Id, t.user2Id),
  ],
);

export const privateChatMessagesTable = pgTable(
  "private_chat_messages",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    conversationId: text("conversation_id").notNull(),
    senderId: text("sender_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    text: text("text").notNull(),
    replyToId: text("reply_to_id"),
    isRead: boolean("is_read").notNull().default(false),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("private_chat_conv_idx").on(t.conversationId),
    index("private_chat_created_idx").on(t.createdAt),
  ],
);

export const chatMessageReportsTable = pgTable(
  "chat_message_reports",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    messageId: text("message_id").notNull(),
    chatType: text("chat_type").notNull(),
    reportedByUserId: text("reported_by_user_id").notNull(),
    reportedUserId: text("reported_user_id"),
    reason: text("reason").notNull(),
    note: text("note"),
    messageSnapshot: text("message_snapshot"),
    messageCreatedAt: timestamp("message_created_at", { withTimezone: true }),
    conversationId: text("conversation_id"),
    raceId: text("race_id"),
    roomId: text("room_id"),
    status: text("status").notNull().default("pending"),
    autoDeleted: boolean("auto_deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("msg_reports_msg_idx").on(t.messageId),
    index("msg_reports_reporter_idx").on(t.reportedByUserId),
    index("msg_reports_status_idx").on(t.status),
    index("msg_reports_created_idx").on(t.createdAt),
  ],
);

export const chatReactionsTable = pgTable(
  "chat_reactions",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    messageId: text("message_id").notNull(),
    messageType: chatReactionTypeEnum("message_type").notNull(),
    userId: text("user_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_reactions_msg_user_idx").on(t.messageId, t.messageType, t.userId),
    index("chat_reactions_msg_idx").on(t.messageId, t.messageType),
  ],
);
