import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  text,
  integer,
  real,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const matchRequestStatusEnum = pgEnum("match_request_status", ["waiting", "connected", "declined"]);
export const matchTypeEnum = pgEnum("match_type", ["lfg", "lfo"]);
export const durationEnum = pgEnum("duration", ["short-term", "long-term"]);
export const genderEnum = pgEnum("gender", ["male", "female", "custom", "prefer_not_to_say"]);
export const notificationTypeEnum = pgEnum("notification_type", [
  "connection_request",
  "connection_accepted",
  "connection_declined",
  "match_application",
  "match_accepted",
  "match_declined"
]);

// Session storage table for authentication
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table - supports both OAuth and local registration
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  googleId: varchar("google_id").unique(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  // Gaming profile fields
  gamertag: varchar("gamertag").unique().notNull(),
  bio: text("bio"),
  location: varchar("location"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  age: integer("age"),
  gender: genderEnum("gender"),
  language: varchar("language"),
  preferredGames: text("preferred_games").array(),
  // Privacy settings for mutuals display
  showMutualGames: varchar("show_mutual_games").default("everyone"), // everyone, connections, nobody
  showMutualFriends: varchar("show_mutual_friends").default("everyone"),
  showMutualHobbies: varchar("show_mutual_hobbies").default("everyone"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Match requests table
export const matchRequests = pgTable("match_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  gameName: varchar("game_name").notNull(),
  gameMode: varchar("game_mode").notNull(), // 1v1, 2v2, 3v3, etc.
  matchType: matchTypeEnum("match_type").notNull().default("lfg"), // lfg (Looking for Group) or lfo (Looking for Opponent)
  duration: durationEnum("duration").notNull().default("short-term"), // short-term or long-term
  tournamentName: varchar("tournament_name"),
  description: text("description").notNull(),
  status: matchRequestStatusEnum("status").notNull().default("waiting"),
  region: varchar("region"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Direct connection requests (user-to-user, no match required)
export const connectionRequests = pgTable("connection_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  senderId: varchar("sender_id").notNull().references(() => users.id),
  receiverId: varchar("receiver_id").notNull().references(() => users.id),
  status: varchar("status").notNull().default("pending"), // pending, accepted, declined
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Match connections table (for match-based connections)
export const matchConnections = pgTable("match_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id").notNull().references(() => matchRequests.id, { onDelete: "cascade" }),
  requesterId: varchar("requester_id").notNull().references(() => users.id),
  accepterId: varchar("accepter_id").notNull().references(() => users.id),
  status: varchar("status").notNull().default("pending"), // pending, accepted, declined
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Hidden matches table - tracks which users have hidden which match requests
export const hiddenMatches = pgTable("hidden_matches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  matchRequestId: varchar("match_request_id").notNull().references(() => matchRequests.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_user_hidden_matches").on(table.userId),
]);

// Chat messages table - stores messages between connected users
// connectionId can reference either connectionRequests or matchConnections
export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull(),
  senderId: varchar("sender_id").notNull().references(() => users.id),
  receiverId: varchar("receiver_id").notNull().references(() => users.id),
  message: text("message").notNull(),
  isRead: varchar("is_read").notNull().default("false"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_receiver_unread").on(table.receiverId, table.isRead),
]);

// Notifications table - stores user notifications for various events
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type").notNull(), // connection_request, connection_accepted, connection_declined, match_application, match_accepted, match_declined
  title: varchar("title").notNull(),
  message: text("message").notNull(),
  relatedUserId: varchar("related_user_id").references(() => users.id), // The user who triggered this notification
  relatedMatchId: varchar("related_match_id").references(() => matchRequests.id),
  isRead: varchar("is_read").notNull().default("false"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_user_notifications").on(table.userId),
  index("idx_notifications_read").on(table.isRead),
]);

// Game profiles table - stores detailed game achievements per user per game
export const gameProfiles = pgTable("game_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  gameName: varchar("game_name").notNull(),
  highestRank: varchar("highest_rank"),
  currentRank: varchar("current_rank"),
  hoursPlayed: integer("hours_played"),
  clipUrls: jsonb("clip_urls"),
  achievements: text("achievements").array(),
  achievementDetails: jsonb("achievement_details"),
  stats: jsonb("stats"),
  statsPhotoUrl: varchar("stats_photo_url"),
  statsPhotoDate: varchar("stats_photo_date"),
  customSections: jsonb("custom_sections"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_user_game_profiles").on(table.userId),
]);

// Hobbies/Interests table - stores user interests beyond gaming
export const hobbies = pgTable("hobbies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: varchar("category").notNull(), // anime, dance, books, music, art, writing, etc.
  title: varchar("title").notNull(),
  description: text("description"),
  link: varchar("link"), // URL to content, video, article, etc.
  imageUrl: varchar("image_url"), // Optional image
  metadata: jsonb("metadata"), // Additional flexible data
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_user_hobbies").on(table.userId),
  index("idx_hobbies_category").on(table.category),
]);

// Portfolio Pages table - stores AI-generated or custom portfolio pages
export const portfolioPages = pgTable("portfolio_pages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  themeName: varchar("theme_name").notNull(), // e.g., "modern", "minimal", "vibrant"
  layout: jsonb("layout").notNull(), // JSON structure with sections, colors, components
  prompt: text("prompt"), // Original prompt used for AI generation
  isActive: varchar("is_active").default("true"), // Whether this is the active portfolio
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_user_portfolios").on(table.userId),
]);

// Voice Channels table - tracks active voice channels per connection
export const voiceChannels = pgTable("voice_channels", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull().unique(), // References either connectionRequests or matchConnections - UNIQUE to prevent duplicate channels
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_connection_voice_channels").on(table.connectionId),
]);

// Voice Participants table - tracks who's currently in each voice channel
export const voiceParticipants = pgTable("voice_participants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  voiceChannelId: varchar("voice_channel_id").notNull().references(() => voiceChannels.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  isMuted: varchar("is_muted").default("false"),
  joinedAt: timestamp("joined_at").defaultNow(),
}, (table) => [
  index("idx_voice_channel_participants").on(table.voiceChannelId),
  index("idx_user_voice_participants").on(table.userId),
  index("idx_unique_voice_participant").on(table.voiceChannelId, table.userId), // Composite unique constraint
]);

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type InsertMatchRequest = typeof matchRequests.$inferInsert;
export type MatchRequest = typeof matchRequests.$inferSelect;
export type InsertConnectionRequest = typeof connectionRequests.$inferInsert;
export type ConnectionRequest = typeof connectionRequests.$inferSelect;
export type InsertMatchConnection = typeof matchConnections.$inferInsert;
export type MatchConnection = typeof matchConnections.$inferSelect;
export type InsertHiddenMatch = typeof hiddenMatches.$inferInsert;
export type HiddenMatch = typeof hiddenMatches.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type InsertGameProfile = typeof gameProfiles.$inferInsert;
export type GameProfile = typeof gameProfiles.$inferSelect;
export type InsertHobby = typeof hobbies.$inferInsert;
export type Hobby = typeof hobbies.$inferSelect;
export type InsertPortfolioPage = typeof portfolioPages.$inferInsert;
export type PortfolioPage = typeof portfolioPages.$inferSelect;
export type InsertVoiceChannel = typeof voiceChannels.$inferInsert;
export type VoiceChannel = typeof voiceChannels.$inferSelect;
export type InsertVoiceParticipant = typeof voiceParticipants.$inferInsert;
export type VoiceParticipant = typeof voiceParticipants.$inferSelect;

// Enhanced match request type that includes user profile data
export type MatchRequestWithUser = MatchRequest & {
  gamertag: string | null;
  profileImageUrl: string | null;
};

// Chat message with sender information
export type ChatMessageWithSender = ChatMessage & {
  senderGamertag: string | null;
  senderProfileImageUrl: string | null;
};

// Connection request with user information
export type ConnectionRequestWithUser = ConnectionRequest & {
  senderGamertag: string | null;
  senderProfileImageUrl: string | null;
  receiverGamertag: string | null;
  receiverProfileImageUrl: string | null;
};

// Match connection with user information
export type MatchConnectionWithUser = MatchConnection & {
  requesterGamertag: string | null;
  requesterProfileImageUrl: string | null;
  accepterGamertag: string | null;
  accepterProfileImageUrl: string | null;
  gameName?: string | null;
  gameMode?: string | null;
};

// Voice participant with user information
export type VoiceParticipantWithUser = VoiceParticipant & {
  gamertag: string | null;
  profileImageUrl: string | null;
};

export const insertUserSchema = createInsertSchema(users);

// Local registration schema - minimal fields required to create account
export const registerUserSchema = z.object({
  gamertag: z.string().min(3, "Gamertag must be at least 3 characters").max(20, "Gamertag must be at most 20 characters"),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  age: z.number().min(13, "You must be at least 13 years old").max(120).optional(),
  gender: z.enum(["male", "female", "custom", "prefer_not_to_say"]).optional(),
  bio: z.string().max(500).optional(),
  location: z.string().optional(),
  preferredGames: z.array(z.string()).optional(),
});

export type RegisterUser = z.infer<typeof registerUserSchema>;

export const insertMatchRequestSchema = createInsertSchema(matchRequests).omit({ id: true, userId: true, createdAt: true, updatedAt: true }).required({ matchType: true, duration: true });
export const insertConnectionRequestSchema = createInsertSchema(connectionRequests).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMatchConnectionSchema = createInsertSchema(matchConnections).omit({ id: true, createdAt: true, updatedAt: true });
export const insertHiddenMatchSchema = createInsertSchema(hiddenMatches).omit({ id: true, createdAt: true });
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true, createdAt: true });
export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true, createdAt: true });
export const insertGameProfileSchema = createInsertSchema(gameProfiles).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export const insertHobbySchema = createInsertSchema(hobbies).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export const insertPortfolioPageSchema = createInsertSchema(portfolioPages).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export const insertVoiceChannelSchema = createInsertSchema(voiceChannels).omit({ id: true, createdAt: true });
export const insertVoiceParticipantSchema = createInsertSchema(voiceParticipants).omit({ id: true, joinedAt: true });

// Privacy settings validation
export const privacyVisibilityEnum = z.enum(["everyone", "connections", "nobody"]);
export const updatePrivacySettingsSchema = z.object({
  showMutualGames: privacyVisibilityEnum.optional(),
  showMutualFriends: privacyVisibilityEnum.optional(),
  showMutualHobbies: privacyVisibilityEnum.optional(),
});