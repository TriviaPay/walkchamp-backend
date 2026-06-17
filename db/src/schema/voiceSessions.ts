import { pgTable, text, uuid, boolean, timestamp } from "drizzle-orm/pg-core";

export const voiceSessionsTable = pgTable("voice_sessions", {
  id:               uuid("id").primaryKey().defaultRandom(),
  raceId:           text("race_id").notNull(),
  userId:           text("user_id").notNull(),
  provider:         text("provider").notNull().default("livekit"),
  roomName:         text("room_name").notNull(),
  canPublishAudio:  boolean("can_publish_audio").notNull().default(false),
  connectedAt:      timestamp("connected_at"),
  disconnectedAt:   timestamp("disconnected_at"),
  disconnectReason: text("disconnect_reason"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
});

export type VoiceSession = typeof voiceSessionsTable.$inferSelect;
