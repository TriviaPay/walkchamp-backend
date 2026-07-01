import { Router, type RequestHandler } from "express";
import multer from "multer";
import { db, pool } from "@db";
import {
  walkingGroupsTable,
  walkingGroupMembersTable,
  walkingGroupInvitesTable,
  walkingGroupDailyStepsTable,
  walkingGroupJoinRequestsTable,
  profilesTable,
  stepDailyTotalsTable,
} from "@db/schema";
import { eq, and, sql, desc, inArray, ne } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { triggerEvent } from "../lib/pusher.js";
import { evaluateAndNotify } from "./achievementHooks.js";
import { sendPushToUser } from "./push.js";
import {
  getUsername,
  notifyWalkingGroupInviteReceived,
  notifyWalkingGroupJoinRequestReceived,
  notifyWalkingGroupRequestAccepted,
  notifyWalkingGroupRequestRejected,
} from "../lib/pushNotificationService.js";
import {
  deleteStoredObject,
  isObjectStorageConfigError,
  isObjectStorageConfigured,
  objectKeyFromUrl,
  objectUrl,
  putStoredObject,
} from "../lib/objectStorage.js";
import { proxyStoredObjectResponse } from "../lib/objectMediaProxy.js";
import { buildGeneratedObjectKey, validateRasterUpload } from "../lib/uploadPolicy.js";
import { sanitizePlainText } from "../lib/text.js";
import { config } from "../lib/config.js";
import { createRedisRateLimit, rateLimitByActorOrIp } from "../lib/rateLimit.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images are allowed"));
  },
});

const router = Router();
const groupImageUploadLimiter: RequestHandler = config.features.rateLimitingEnabled
  ? createRedisRateLimit({
      bucket: "group-image-upload",
      windowMs: 15 * 60 * 1000,
      max: 20,
      failureMode: "closed",
      message: "Too many upload attempts — please try again later.",
      code: "UPLOAD_RATE_LIMITED",
      key: rateLimitByActorOrIp,
    })
  : (_req, _res, next) => next();

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

function makeInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function getProfile(userId: string) {
  const [p] = await db
    .select({
      id: profilesTable.id,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      avatarUrl: profilesTable.avatarUrl,
      countryCode: profilesTable.countryCode,
    })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  return p ?? null;
}

async function getActiveGroupMembersCount(groupId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.status, "active")));
  return row?.count ?? 0;
}

async function assertMember(groupId: string, userId: string): Promise<{ role: string } | null> {
  const [m] = await db
    .select({ role: walkingGroupMembersTable.role })
    .from(walkingGroupMembersTable)
    .where(
      and(
        eq(walkingGroupMembersTable.groupId, groupId),
        eq(walkingGroupMembersTable.userId, userId),
        eq(walkingGroupMembersTable.status, "active"),
      ),
    )
    .limit(1);
  return m ?? null;
}

async function broadcastGroupSteps(groupId: string, date: string) {
  const members = await db
    .select({
      userId: walkingGroupDailyStepsTable.userId,
      dailySteps: walkingGroupDailyStepsTable.dailySteps,
    })
    .from(walkingGroupDailyStepsTable)
    .where(and(eq(walkingGroupDailyStepsTable.groupId, groupId), eq(walkingGroupDailyStepsTable.stepDate, date)));

  const total = members.reduce((s, m) => s + m.dailySteps, 0);
  await triggerEvent(`public-group-${groupId}`, "group.steps.updated", { date, members, total });
}


// ── GET /api/groups/overview ───────────────────────────────────────────────────
// Returns predefined card status for current user (which types they're in).
router.get("/groups/overview", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  req.log.info({ userId }, "[Groups] overview fetch");

  const PREDEFINED = [
    { type: "friends", label: "Friends", subtitle: "Daily steps with your close circle" },
    { type: "family", label: "Family", subtitle: "Stay active together every day" },
    { type: "office", label: "Office", subtitle: "Team walking goals for coworkers" },
    { type: "custom", label: "Custom Group", subtitle: "Create your own walking squad" },
  ];

  const rawLocalDate = req.query.localDate as string | undefined;
  const today = rawLocalDate && /^\d{4}-\d{2}-\d{2}$/.test(rawLocalDate) ? rawLocalDate : todayUtc();

  // Find all groups the user is an active member of
  const memberships = await db
    .select({
      groupId: walkingGroupMembersTable.groupId,
      role: walkingGroupMembersTable.role,
    })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.userId, userId), eq(walkingGroupMembersTable.status, "active")));

  const groupIds = memberships.map((m) => m.groupId);
  const roleMap = Object.fromEntries(memberships.map((m) => [m.groupId, m.role]));

  let groups: typeof walkingGroupsTable.$inferSelect[] = [];
  if (groupIds.length > 0) {
    groups = await db
      .select()
      .from(walkingGroupsTable)
      .where(and(inArray(walkingGroupsTable.id, groupIds), eq(walkingGroupsTable.status, "active")));
  }

  // Today's total steps per group
  let todaySteps: { groupId: string; total: number }[] = [];
  if (groupIds.length > 0) {
    todaySteps = await db
      .select({
        groupId: walkingGroupDailyStepsTable.groupId,
        total: sql<number>`sum(${walkingGroupDailyStepsTable.dailySteps})::int`,
      })
      .from(walkingGroupDailyStepsTable)
      .where(
        and(
          inArray(walkingGroupDailyStepsTable.groupId, groupIds),
          sql`${walkingGroupDailyStepsTable.stepDate}::date = ${today}::date`,
        ),
      )
      .groupBy(walkingGroupDailyStepsTable.groupId);
  }
  const todayMap = Object.fromEntries(todaySteps.map((r) => [r.groupId, r.total]));

  // Member counts
  let memberCounts: { groupId: string; count: number }[] = [];
  if (groupIds.length > 0) {
    memberCounts = await db
      .select({
        groupId: walkingGroupMembersTable.groupId,
        count: sql<number>`count(*)::int`,
      })
      .from(walkingGroupMembersTable)
      .where(
        and(
          inArray(walkingGroupMembersTable.groupId, groupIds),
          eq(walkingGroupMembersTable.status, "active"),
        ),
      )
      .groupBy(walkingGroupMembersTable.groupId);
  }
  const countMap = Object.fromEntries(memberCounts.map((r) => [r.groupId, r.count]));

  // ── Extra queries for enriched group cards ────────────────────────────────

  // All members of user's groups (for avatar stacks and top-walker lookup)
  const allGroupMemberRows = groupIds.length > 0
    ? await db
      .select({ groupId: walkingGroupMembersTable.groupId, userId: walkingGroupMembersTable.userId })
      .from(walkingGroupMembersTable)
      .where(and(inArray(walkingGroupMembersTable.groupId, groupIds), eq(walkingGroupMembersTable.status, "active")))
    : [];

  const allMemberIds = [...new Set(allGroupMemberRows.map((m) => m.userId))];
  const allMemberProfiles = allMemberIds.length > 0
    ? await db
      .select({
        id: profilesTable.id,
        username: profilesTable.username,
        avatarUrl: profilesTable.avatarUrl,
        avatarColor: profilesTable.avatarColor,
      })
      .from(profilesTable)
      .where(inArray(profilesTable.id, allMemberIds))
    : [];
  const allMemberProfileMap = Object.fromEntries(allMemberProfiles.map((p) => [p.id, p]));

  // Build member avatar stacks per group (first 5)
  const membersByGroupId: Record<string, { groupId: string; userId: string }[]> = {};
  for (const m of allGroupMemberRows) {
    if (!membersByGroupId[m.groupId]) membersByGroupId[m.groupId] = [];
    membersByGroupId[m.groupId].push(m);
  }
  const memberAvatarsPerGroup: Record<string, { userId: string; username: string; avatarUrl: string | null; avatarColor: string | null }[]> = {};
  for (const gId of groupIds) {
    memberAvatarsPerGroup[gId] = (membersByGroupId[gId] ?? []).slice(0, 5).map((m) => ({
      userId: m.userId,
      username: allMemberProfileMap[m.userId]?.username ?? "?",
      avatarUrl: allMemberProfileMap[m.userId]?.avatarUrl ?? null,
      avatarColor: allMemberProfileMap[m.userId]?.avatarColor ?? null,
    }));
  }

  // Today's steps per member per group (for top-walker and user's own steps per group)
  const allGroupTodaySteps = groupIds.length > 0
    ? await db
      .select({
        groupId: walkingGroupDailyStepsTable.groupId,
        userId: walkingGroupDailyStepsTable.userId,
        steps: walkingGroupDailyStepsTable.dailySteps,
      })
      .from(walkingGroupDailyStepsTable)
      .where(and(inArray(walkingGroupDailyStepsTable.groupId, groupIds), sql`${walkingGroupDailyStepsTable.stepDate}::date = ${today}::date`))
    : [];

  const userGroupStepsMap: Record<string, number> = {};
  const topWalkerPerGroup: Record<string, { userId: string; steps: number }> = {};
  for (const row of allGroupTodaySteps) {
    if (row.userId === userId) userGroupStepsMap[row.groupId] = row.steps;
    if (!topWalkerPerGroup[row.groupId] || row.steps > topWalkerPerGroup[row.groupId].steps) {
      topWalkerPerGroup[row.groupId] = { userId: row.userId, steps: row.steps };
    }
  }

  // User's own total daily steps today (from main step-tracking table)
  const [userTodayRow] = await db
    .select({ steps: stepDailyTotalsTable.steps })
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
    .limit(1);
  const userTodaySteps = userTodayRow?.steps ?? 0;

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalActiveMembers = groups.reduce((s, g) => s + (countMap[g.id] ?? 0), 0);
  const summary = {
    total_groups: groups.length,
    today_user_steps: userTodaySteps,
    active_members_total: totalActiveMembers,
  };

  // ── Filter chips ───────────────────────────────────────────────────────────
  const filterTypes = ["friends", "family", "office", "custom"] as const;
  const filterChips = [
    { group_type: "all", label: "All", count: groups.length },
    ...filterTypes.map((type) => ({
      group_type: type,
      label: type.charAt(0).toUpperCase() + type.slice(1),
      count: groups.filter((g) => g.groupType === type).length,
    })),
  ];

  // ── Pending invites for user ───────────────────────────────────────────────
  const pendingInvites = await db
    .select({
      id: walkingGroupInvitesTable.id,
      groupId: walkingGroupInvitesTable.groupId,
      invitedByUserId: walkingGroupInvitesTable.invitedByUserId,
      createdAt: walkingGroupInvitesTable.createdAt,
    })
    .from(walkingGroupInvitesTable)
    .where(and(eq(walkingGroupInvitesTable.invitedUserId, userId), eq(walkingGroupInvitesTable.status, "pending")))
    .orderBy(desc(walkingGroupInvitesTable.createdAt));

  const inviteGroupIds = [...new Set(pendingInvites.map((i) => i.groupId))];
  let inviteGroups: typeof walkingGroupsTable.$inferSelect[] = [];
  if (inviteGroupIds.length > 0) {
    inviteGroups = await db.select().from(walkingGroupsTable).where(inArray(walkingGroupsTable.id, inviteGroupIds));
  }
  const inviteGroupMap = Object.fromEntries(inviteGroups.map((g) => [g.id, g]));

  const invitedByIds = [...new Set(pendingInvites.map((i) => i.invitedByUserId))];
  let invitedByProfiles: { id: string; username: string | null }[] = [];
  if (invitedByIds.length > 0) {
    invitedByProfiles = await db
      .select({ id: profilesTable.id, username: profilesTable.username })
      .from(profilesTable)
      .where(inArray(profilesTable.id, invitedByIds));
  }
  const invitedByMap = Object.fromEntries(invitedByProfiles.map((p) => [p.id, p.username]));

  const enrichedInvites = pendingInvites.map((inv) => ({
    ...inv,
    group: inviteGroupMap[inv.groupId] ?? null,
    invitedByUsername: invitedByMap[inv.invitedByUserId] ?? null,
  }));

  // ── Color theme fallbacks per group type ──────────────────────────────────
  const TYPE_DEFAULT_THEME: Record<string, string> = {
    friends: "friends_blue_purple",
    family: "family_pink_orange",
    office: "office_teal_green",
    custom: "custom_purple_blue",
  };

  // ── Flat list of ALL user groups ───────────────────────────────────────────
  const allUserGroups = groups.map((g) => {
    const tw = topWalkerPerGroup[g.id];
    return {
      groupId: g.id,
      groupName: g.groupName,
      groupType: g.groupType,
      customGroupType: g.customGroupType ?? null,
      groupImageUrl: g.groupImageUrl ?? null,
      colorThemeKey: g.themeKey ?? TYPE_DEFAULT_THEME[g.groupType] ?? "custom_purple_blue",
      userRole: roleMap[g.id] ?? "member",
      memberCount: countMap[g.id] ?? 0,
      dailyGoalSteps: g.dailyGoalSteps,
      todayGroupSteps: todayMap[g.id] ?? 0,
      currentUserTodaySteps: Math.max(userGroupStepsMap[g.id] ?? 0, userTodaySteps),
      progressPercent: g.dailyGoalSteps > 0 && (countMap[g.id] ?? 0) > 0
        ? Math.min(100, Math.round(((todayMap[g.id] ?? 0) / (g.dailyGoalSteps * (countMap[g.id] ?? 1))) * 100))
        : 0,
      inviteCode: g.inviteCode,
      topWalker: tw
        ? {
          userId: tw.userId,
          username: allMemberProfileMap[tw.userId]?.username ?? "Unknown",
          avatarUrl: allMemberProfileMap[tw.userId]?.avatarUrl ?? null,
          steps: tw.steps,
        }
        : null,
      memberAvatars: memberAvatarsPerGroup[g.id] ?? [],
    };
  });

  return res.json({
    success: true,
    summary,
    filters: filterChips,
    groups: allUserGroups,
    pendingInvites: enrichedInvites,
  });
});

// ── Color theme helpers ────────────────────────────────────────────────────────
const GROUP_TYPE_THEME: Record<string, string> = {
  friends: "friends_blue_purple",
  family: "family_pink_orange",
  office: "office_teal_green",
};
const VALID_CUSTOM_THEME_KEYS = new Set([
  "custom_purple_blue", "custom_cyan_green", "custom_pink_orange",
  "custom_gold_amber", "custom_red_rose", "custom_teal_mint",
]);

// ── POST /api/groups ───────────────────────────────────────────────────────────
const createGroupSchema = z.object({
  groupName: z.string().min(1).max(60),
  groupType: z.enum(["friends", "family", "office", "custom"]),
  customGroupType: z.string().min(2).max(30).trim().optional(),
  dailyGoalSteps: z.number().int().min(1000).max(100000).default(10000),
  colorThemeKey: z.string().optional(),
}).refine(
  (d) => d.groupType !== "custom" || (typeof d.customGroupType === "string" && d.customGroupType.trim().length >= 2),
  { message: "customGroupType is required for custom groups", path: ["customGroupType"] },
);

router.post("/groups", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });

  const groupName = sanitizePlainText(parsed.data.groupName);
  const groupType = parsed.data.groupType;
  const customGroupType = parsed.data.customGroupType ? sanitizePlainText(parsed.data.customGroupType) : undefined;
  const dailyGoalSteps = parsed.data.dailyGoalSteps;
  const colorThemeKey = parsed.data.colorThemeKey;
  if (!groupName) return res.status(400).json({ error: "Group name is required." });
  req.log.info({ userId, groupType, customGroupType }, "[Groups] create clicked");

  const [existing] = await db
    .select({ id: walkingGroupsTable.id })
    .from(walkingGroupsTable)
    .where(
      and(
        sql`lower(${walkingGroupsTable.groupName}) = lower(${groupName})`,
        ne(walkingGroupsTable.status, "deleted"),
      ),
    )
    .limit(1);
  if (existing) {
    return res.status(409).json({ error: "GROUP_NAME_EXISTS", message: "A group with this name already exists." });
  }

  const inviteCode = makeInviteCode();

  // Derive the stored theme key
  let effectiveThemeKey: string;
  if (groupType === "custom") {
    effectiveThemeKey = (colorThemeKey && VALID_CUSTOM_THEME_KEYS.has(colorThemeKey))
      ? colorThemeKey
      : "custom_purple_blue";
  } else {
    effectiveThemeKey = GROUP_TYPE_THEME[groupType] ?? groupType;
  }

  const [group] = await db
    .insert(walkingGroupsTable)
    .values({ groupName, groupType, customGroupType: groupType === "custom" ? (customGroupType ?? null) : null, adminUserId: userId, dailyGoalSteps, inviteCode, themeKey: effectiveThemeKey })
    .returning();

  await db.insert(walkingGroupMembersTable).values({
    groupId: group.id,
    userId,
    role: "admin",
    status: "active",
    joinedAt: new Date(),
  });

  req.log.info({ groupId: group.id, userId }, "[Groups] create response: success");
  await triggerEvent(`private-user-${userId}`, "group.created", { groupId: group.id });
  evaluateAndNotify(userId).catch(() => {});

  return res.status(201).json({ success: true, group: { ...group } });
});

// ── GET /api/groups/my-invites ─────────────────────────────────────────────────
router.get("/groups/my-invites", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const invites = await db
    .select()
    .from(walkingGroupInvitesTable)
    .where(and(eq(walkingGroupInvitesTable.invitedUserId, userId), eq(walkingGroupInvitesTable.status, "pending")))
    .orderBy(desc(walkingGroupInvitesTable.createdAt));

  const groupIds = [...new Set(invites.map((i) => i.groupId))];
  let groups: typeof walkingGroupsTable.$inferSelect[] = [];
  if (groupIds.length > 0) {
    groups = await db.select().from(walkingGroupsTable).where(inArray(walkingGroupsTable.id, groupIds));
  }
  const groupMap = Object.fromEntries(groups.map((g) => [g.id, g]));

  const enriched = invites.map((inv) => ({ ...inv, group: groupMap[inv.groupId] ?? null }));
  return res.json({ success: true, invites: enriched });
});

// ── GET /api/groups/:groupId ───────────────────────────────────────────────────
router.get("/groups/:groupId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });

  const membership = await assertMember(groupId, userId);
  if (!membership) return res.status(403).json({ error: "Not a group member" });

  const rawLocalDate = req.query.localDate as string | undefined;
  const today = rawLocalDate && /^\d{4}-\d{2}-\d{2}$/.test(rawLocalDate) ? rawLocalDate : todayUtc();

  // Members with profiles
  const members = await db
    .select({
      id: walkingGroupMembersTable.id,
      userId: walkingGroupMembersTable.userId,
      role: walkingGroupMembersTable.role,
      joinedAt: walkingGroupMembersTable.joinedAt,
    })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.status, "active")));

  const memberUserIds = members.map((m) => m.userId);
  let profiles: { id: string; username: string; fullName: string | null; avatarUrl: string | null; countryCode: string | null }[] = [];
  if (memberUserIds.length > 0) {
    profiles = await db
      .select({
        id: profilesTable.id,
        username: profilesTable.username,
        fullName: profilesTable.fullName,
        avatarUrl: profilesTable.avatarUrl,
        countryCode: profilesTable.countryCode,
      })
      .from(profilesTable)
      .where(inArray(profilesTable.id, memberUserIds));
  }
  const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p]));

  // Today's steps per member
  const todaySteps = await db
    .select({
      userId: walkingGroupDailyStepsTable.userId,
      dailySteps: walkingGroupDailyStepsTable.dailySteps,
    })
    .from(walkingGroupDailyStepsTable)
    .where(and(eq(walkingGroupDailyStepsTable.groupId, groupId), sql`${walkingGroupDailyStepsTable.stepDate}::date = ${today}::date`));
  const todayMap = Object.fromEntries(todaySteps.map((r) => [r.userId, r.dailySteps]));

  // All-time steps per member (sum)
  const allTimeSteps = await db
    .select({
      userId: walkingGroupDailyStepsTable.userId,
      total: sql<number>`sum(${walkingGroupDailyStepsTable.dailySteps})::int`,
    })
    .from(walkingGroupDailyStepsTable)
    .where(eq(walkingGroupDailyStepsTable.groupId, groupId))
    .groupBy(walkingGroupDailyStepsTable.userId);
  const allTimeMap = Object.fromEntries(allTimeSteps.map((r) => [r.userId, r.total]));

  // ── Overall group stats ────────────────────────────────────────────────────
  const allStepsRaw = await db
    .select({
      stepDate: walkingGroupDailyStepsTable.stepDate,
      userId: walkingGroupDailyStepsTable.userId,
      dailySteps: walkingGroupDailyStepsTable.dailySteps,
      distanceMeters: walkingGroupDailyStepsTable.distanceMeters,
    })
    .from(walkingGroupDailyStepsTable)
    .where(eq(walkingGroupDailyStepsTable.groupId, groupId));

  const byDate = new Map<string, number>();
  let totalDistM = 0;
  const distByUser: Record<string, number> = {};
  for (const row of allStepsRaw) {
    const ds = row.stepDate as string;
    byDate.set(ds, (byDate.get(ds) ?? 0) + row.dailySteps);
    const dm = parseFloat(row.distanceMeters?.toString() ?? "0");
    totalDistM += dm;
    distByUser[row.userId] = (distByUser[row.userId] ?? 0) + dm;
  }

  const sortedDates = [...byDate.keys()].sort();
  let bestStreak = 0, curStrk = 0;
  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) { curStrk = 1; }
    else {
      const a = new Date(sortedDates[i - 1] + "T00:00:00Z");
      const b = new Date(sortedDates[i] + "T00:00:00Z");
      curStrk = (b.getTime() - a.getTime()) / 86400000 === 1 ? curStrk + 1 : 1;
    }
    bestStreak = Math.max(bestStreak, curStrk);
  }

  const todayTs = new Date(today + "T00:00:00Z").getTime();
  let last7 = 0, prev7 = 0;
  for (const [ds, steps] of byDate) {
    const daysAgo = (todayTs - new Date(ds + "T00:00:00Z").getTime()) / 86400000;
    if (daysAgo < 7) last7 += steps;
    else if (daysAgo < 14) prev7 += steps;
  }
  const weeklyMomentumPct = prev7 > 0
    ? Math.round(((last7 - prev7) / prev7) * 100)
    : last7 > 0 ? 100 : 0;
  const totalDistKm = parseFloat((totalDistM / 1000).toFixed(1));
  const totalGroupAllTime = allTimeSteps.reduce((s, r) => s + (r.total ?? 0), 0);
  const avgDailyStepsPerMember =
    members.length > 0 && byDate.size > 0
      ? Math.round(totalGroupAllTime / members.length / byDate.size)
      : 0;

  // Last 14 days group totals for sparkline (today first)
  const sparkline: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(todayTs - i * 86400000).toISOString().split("T")[0];
    sparkline.push(byDate.get(d) ?? 0);
  }

  // Pending invites for admin members tab
  let pendingGroupInvites: Record<string, unknown>[] = [];
  if (membership.role === "admin") {
    const rawInvites = await db
      .select()
      .from(walkingGroupInvitesTable)
      .where(and(eq(walkingGroupInvitesTable.groupId, groupId), eq(walkingGroupInvitesTable.status, "pending")));
    if (rawInvites.length > 0) {
      const invUserIds = rawInvites.map((i) => i.invitedUserId);
      const invProfiles = await db
        .select({
          id: profilesTable.id,
          username: profilesTable.username,
          fullName: profilesTable.fullName,
          avatarUrl: profilesTable.avatarUrl,
          countryCode: profilesTable.countryCode,
        })
        .from(profilesTable)
        .where(inArray(profilesTable.id, invUserIds));
      const ipMap = Object.fromEntries(invProfiles.map((p) => [p.id, p]));
      pendingGroupInvites = rawInvites.map((inv) => ({ ...inv, invitedProfile: ipMap[inv.invitedUserId] ?? null }));
    }
  }

  const enrichedMembers = members.map((m) => ({
    ...m,
    profile: profileMap[m.userId] ?? null,
    todaySteps: todayMap[m.userId] ?? 0,
    allTimeSteps: allTimeMap[m.userId] ?? 0,
    distanceKm: parseFloat(((distByUser[m.userId] ?? 0) / 1000).toFixed(1)),
    isCurrentUser: m.userId === userId,
  }));

  const todayTotal = Object.values(todayMap).reduce((s, v) => s + v, 0);

  // History: derive last 30 days from walkingGroupDailyStepsTable (past days only)
  const historyRaw = await db
    .select({
      stepDate: walkingGroupDailyStepsTable.stepDate,
      groupTotalSteps: sql<number>`sum(${walkingGroupDailyStepsTable.dailySteps})::int`,
    })
    .from(walkingGroupDailyStepsTable)
    .where(
      and(
        eq(walkingGroupDailyStepsTable.groupId, groupId),
        sql`${walkingGroupDailyStepsTable.stepDate} < ${today}`,
      ),
    )
    .groupBy(walkingGroupDailyStepsTable.stepDate)
    .orderBy(desc(walkingGroupDailyStepsTable.stepDate))
    .limit(30);
  const memberCount = members.length;
  const history = historyRaw.map((r) => ({
    id: String(r.stepDate),
    resultDate: String(r.stepDate),
    groupTotalSteps: r.groupTotalSteps,
    dailyGoalSteps: group.dailyGoalSteps,
    goalCompleted: r.groupTotalSteps >= group.dailyGoalSteps * memberCount,
  }));

  return res.json({
    success: true,
    group: {
      ...group,
      memberCount: members.length,
      todayTotal,
      userRole: membership.role,
    },
    members: enrichedMembers,
    history,
    groupStats: {
      bestStreak,
      weeklyMomentumPct,
      totalDistKm,
      avgDailyStepsPerMember,
      activeDays: byDate.size,
      totalGroupAllTime,
      sparkline,
    },
    pendingGroupInvites,
  });
});

// ── PATCH /api/groups/:groupId ─────────────────────────────────────────────────
const updateGroupSchema = z.object({
  groupName: z.string().min(1).max(60).optional(),
  dailyGoalSteps: z.number().int().min(1000).max(100000).optional(),
  themeKey: z.string().optional(),
  customGroupType: z.string().min(2).max(30).trim().optional(),
});

router.patch("/groups/:groupId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });
  if (group.adminUserId !== userId) return res.status(403).json({ error: "Admin only" });

  const parsed = updateGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const groupName = parsed.data.groupName !== undefined ? sanitizePlainText(parsed.data.groupName) : undefined;
  const dailyGoalSteps = parsed.data.dailyGoalSteps;
  const themeKey = parsed.data.themeKey;
  const customGroupType = parsed.data.customGroupType !== undefined
    ? sanitizePlainText(parsed.data.customGroupType)
    : undefined;

  const updates: Partial<typeof walkingGroupsTable.$inferInsert> = { updatedAt: new Date() };
  if (groupName !== undefined) updates.groupName = groupName;
  if (dailyGoalSteps !== undefined) updates.dailyGoalSteps = dailyGoalSteps;
  if (themeKey !== undefined) updates.themeKey = themeKey;
  if (customGroupType !== undefined) updates.customGroupType = customGroupType;

  const [updated] = await db.update(walkingGroupsTable).set(updates).where(eq(walkingGroupsTable.id, groupId)).returning();

  req.log.info({ groupId, userId, updates }, "[Groups] goal updated");
  await triggerEvent(`public-group-${groupId}`, "group.goal.updated", { dailyGoalSteps: updated.dailyGoalSteps, groupName: updated.groupName });

  return res.json({ success: true, group: updated });
});

// ── POST /api/groups/:groupId/invite ──────────────────────────────────────────
router.post("/groups/:groupId/invite", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });
  if (group.adminUserId !== userId) return res.status(403).json({ error: "Admin only" });

  const { username } = z.object({ username: z.string().min(1) }).parse(req.body);

  // Find target user
  const [targetProfile] = await db
    .select({ id: profilesTable.id, username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.username, username))
    .limit(1);
  if (!targetProfile) return res.status(404).json({ error: "User not found" });
  if (targetProfile.id === userId) return res.status(400).json({ error: "Cannot invite yourself" });

  // Check already a member
  const existing = await assertMember(groupId, targetProfile.id);
  if (existing) return res.status(400).json({ error: "User is already a member" });

  // Check pending invite
  const [pendingInv] = await db
    .select({ id: walkingGroupInvitesTable.id })
    .from(walkingGroupInvitesTable)
    .where(
      and(
        eq(walkingGroupInvitesTable.groupId, groupId),
        eq(walkingGroupInvitesTable.invitedUserId, targetProfile.id),
        eq(walkingGroupInvitesTable.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingInv) return res.status(400).json({ error: "Invite already pending" });

  const [invite] = await db
    .insert(walkingGroupInvitesTable)
    .values({
      groupId,
      invitedUserId: targetProfile.id,
      invitedByUserId: userId,
    })
    .returning();

  const [inviterProfile] = await db
    .select({ username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  req.log.info({ groupId, targetUserId: targetProfile.id }, "[Groups] invite sent");
  await triggerEvent(`private-user-${targetProfile.id}`, "group.invite.sent", {
    inviteId: invite.id,
    groupId,
    groupName: group.groupName,
    groupType: group.groupType,
  });
  void notifyWalkingGroupInviteReceived({
    invitedUserId: targetProfile.id,
    inviterUserId: userId,
    inviterUsername: inviterProfile?.username ?? targetProfile.username ?? "Someone",
    walkingGroupId: groupId,
    walkingGroupName: group.groupName,
    walkingGroupInviteId: invite.id,
  });

  return res.status(201).json({ success: true, invite });
});

// ── POST /api/groups/invites/:inviteId/accept ─────────────────────────────────
router.post("/groups/invites/:inviteId/accept", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const inviteId = String(req.params.inviteId);

  const [invite] = await db
    .select()
    .from(walkingGroupInvitesTable)
    .where(and(eq(walkingGroupInvitesTable.id, inviteId), eq(walkingGroupInvitesTable.invitedUserId, userId)))
    .limit(1);
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.status !== "pending") return res.status(400).json({ error: "Invite already responded" });

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, invite.groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group no longer active" });

  await db
    .update(walkingGroupInvitesTable)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(eq(walkingGroupInvitesTable.id, inviteId));

  // Upsert member row
  await db
    .insert(walkingGroupMembersTable)
    .values({ groupId: invite.groupId, userId, role: "member", status: "active", joinedAt: new Date() })
    .onConflictDoUpdate({
      target: [walkingGroupMembersTable.groupId, walkingGroupMembersTable.userId],
      set: { status: "active", joinedAt: new Date(), removedAt: null },
    });

  req.log.info({ inviteId, groupId: invite.groupId, userId }, "[Groups] invite accepted");
  await triggerEvent(`public-group-${invite.groupId}`, "group.invite.accepted", { userId, groupId: invite.groupId });
  await sendPushToUser(
    invite.invitedByUserId,
    "Invite Accepted",
    `Someone joined "${group.groupName}"`,
    { type: "group_invite_accepted", groupId: invite.groupId },
  );

  return res.json({ success: true, groupId: invite.groupId });
});

// ── POST /api/groups/invites/:inviteId/decline ────────────────────────────────
router.post("/groups/invites/:inviteId/decline", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const inviteId = String(req.params.inviteId);

  const [invite] = await db
    .select()
    .from(walkingGroupInvitesTable)
    .where(and(eq(walkingGroupInvitesTable.id, inviteId), eq(walkingGroupInvitesTable.invitedUserId, userId)))
    .limit(1);
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.status !== "pending") return res.status(400).json({ error: "Invite already responded" });

  await db
    .update(walkingGroupInvitesTable)
    .set({ status: "declined", respondedAt: new Date() })
    .where(eq(walkingGroupInvitesTable.id, inviteId));

  req.log.info({ inviteId, userId }, "[Groups] invite declined");
  return res.json({ success: true });
});

// ── POST /api/groups/invites/:inviteId/cancel ─────────────────────────────────
router.post("/groups/invites/:inviteId/cancel", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const inviteId = String(req.params.inviteId);

  const [invite] = await db
    .select()
    .from(walkingGroupInvitesTable)
    .where(and(eq(walkingGroupInvitesTable.id, inviteId), eq(walkingGroupInvitesTable.status, "pending")))
    .limit(1);
  if (!invite) return res.status(404).json({ error: "Invite not found or already resolved" });

  const [group] = await db
    .select()
    .from(walkingGroupsTable)
    .where(eq(walkingGroupsTable.id, invite.groupId))
    .limit(1);
  if (!group || group.adminUserId !== userId) return res.status(403).json({ error: "Admin only" });

  await db
    .update(walkingGroupInvitesTable)
    .set({ status: "cancelled", respondedAt: new Date() })
    .where(eq(walkingGroupInvitesTable.id, inviteId));

  req.log.info({ inviteId, groupId: invite.groupId, userId }, "[Groups] invite cancelled by admin");
  return res.json({ success: true });
});

// ── POST /api/groups/:groupId/members/:userId/remove ──────────────────────────
router.post("/groups/:groupId/members/:targetId/remove", requireAuth, async (req, res) => {
  const adminId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);
  const targetId = String(req.params.targetId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });
  if (group.adminUserId !== adminId) return res.status(403).json({ error: "Admin only" });
  if (targetId === adminId) return res.status(400).json({ error: "Admin cannot remove themselves" });

  await db
    .update(walkingGroupMembersTable)
    .set({ status: "removed", removedAt: new Date() })
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.userId, targetId)));

  req.log.info({ groupId, targetId }, "[Groups] member removed");
  await triggerEvent(`public-group-${groupId}`, "group.member.removed", { userId: targetId });
  await sendPushToUser(targetId, "Removed from Group", `You've been removed from "${group.groupName}"`);

  return res.json({ success: true });
});

// ── POST /api/groups/:groupId/leave ───────────────────────────────────────────
const leaveGroupSchema = z.object({
  newAdminId: z.string().optional(),
});

router.post("/groups/:groupId/leave", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const parsed = leaveGroupSchema.safeParse(req.body ?? {});
  const newAdminId = parsed.success ? parsed.data.newAdminId : undefined;

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });

  const membership = await assertMember(groupId, userId);
  if (!membership) return res.status(403).json({ error: "Not a group member" });

  if (group.adminUserId === userId) {
    const count = await getActiveGroupMembersCount(groupId);
    if (count > 1) {
      // Admin with other members — must transfer admin first
      if (!newAdminId) {
        return res.status(400).json({ error: "TRANSFER_REQUIRED", message: "Select a member to transfer admin rights to before leaving." });
      }
      if (newAdminId === userId) {
        return res.status(400).json({ error: "Cannot transfer admin to yourself." });
      }
      const newAdminMembership = await assertMember(groupId, newAdminId);
      if (!newAdminMembership) {
        return res.status(404).json({ error: "Selected member is not active in this group." });
      }
      // Transfer admin role
      await db.update(walkingGroupsTable)
        .set({ adminUserId: newAdminId, updatedAt: new Date() })
        .where(eq(walkingGroupsTable.id, groupId));
      await db.update(walkingGroupMembersTable)
        .set({ role: "admin" })
        .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.userId, newAdminId)));
      await db.update(walkingGroupMembersTable)
        .set({ role: "member" })
        .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.userId, userId)));
      await triggerEvent(`public-group-${groupId}`, "group.admin.transferred", { newAdminId, prevAdminId: userId });
      req.log.info({ groupId, userId, newAdminId }, "[Groups] admin transferred");
    } else {
      // Admin is the last member — archive group
      await db.update(walkingGroupsTable)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(walkingGroupsTable.id, groupId));
      req.log.info({ groupId, userId }, "[Groups] last admin leaving — group archived");
    }
  }

  await db
    .update(walkingGroupMembersTable)
    .set({ status: "left", removedAt: new Date() })
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.userId, userId)));

  await triggerEvent(`public-group-${groupId}`, "group.member.left", { userId });
  req.log.info({ groupId, userId }, "[Groups] user left");
  return res.json({ success: true });
});

// ── GET /api/groups/:groupId/leaderboard ──────────────────────────────────────
router.get("/groups/:groupId/leaderboard", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);
  const range = (req.query.range as string) ?? "today"; // today | all_time

  const membership = await assertMember(groupId, userId);
  if (!membership) return res.status(403).json({ error: "Not a group member" });

  const members = await db
    .select({ userId: walkingGroupMembersTable.userId, role: walkingGroupMembersTable.role })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.status, "active")));

  const memberUserIds = members.map((m) => m.userId);
  const roleMap = Object.fromEntries(members.map((m) => [m.userId, m.role]));

  let profiles: { id: string; username: string; fullName: string | null; avatarUrl: string | null; countryCode: string | null }[] = [];
  if (memberUserIds.length > 0) {
    profiles = await db
      .select({
        id: profilesTable.id,
        username: profilesTable.username,
        fullName: profilesTable.fullName,
        avatarUrl: profilesTable.avatarUrl,
        countryCode: profilesTable.countryCode,
      })
      .from(profilesTable)
      .where(inArray(profilesTable.id, memberUserIds));
  }
  const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p]));

  let stepData: { userId: string; steps: number }[] = [];
  if (memberUserIds.length > 0) {
    if (range === "today") {
      const rawLD = req.query.localDate as string | undefined;
      const today = rawLD && /^\d{4}-\d{2}-\d{2}$/.test(rawLD) ? rawLD : todayUtc();
      const rows = await db
        .select({
          userId: walkingGroupDailyStepsTable.userId,
          steps: walkingGroupDailyStepsTable.dailySteps,
        })
        .from(walkingGroupDailyStepsTable)
        .where(
          and(
            eq(walkingGroupDailyStepsTable.groupId, groupId),
            sql`${walkingGroupDailyStepsTable.stepDate}::date = ${today}::date`,
            inArray(walkingGroupDailyStepsTable.userId, memberUserIds),
          ),
        );
      stepData = rows.map((r) => ({ userId: r.userId, steps: r.steps }));
    } else {
      const rows = await db
        .select({
          userId: walkingGroupDailyStepsTable.userId,
          steps: sql<number>`sum(${walkingGroupDailyStepsTable.dailySteps})::int`,
        })
        .from(walkingGroupDailyStepsTable)
        .where(
          and(
            eq(walkingGroupDailyStepsTable.groupId, groupId),
            inArray(walkingGroupDailyStepsTable.userId, memberUserIds),
          ),
        )
        .groupBy(walkingGroupDailyStepsTable.userId);
      stepData = rows.map((r) => ({ userId: r.userId, steps: r.steps }));
    }
  }

  // Merge zero-step members
  const stepMap = Object.fromEntries(stepData.map((r) => [r.userId, r.steps]));
  const leaderboard = memberUserIds
    .map((uid, i) => ({
      rank: 0,
      userId: uid,
      profile: profileMap[uid] ?? null,
      steps: stepMap[uid] ?? 0,
      role: roleMap[uid] ?? "member",
      isCurrentUser: uid === userId,
    }))
    .sort((a, b) => b.steps - a.steps)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  req.log.info({ groupId, range, count: leaderboard.length }, "[Groups] leaderboard updated");
  return res.json({ success: true, range, leaderboard });
});

// ── POST /api/groups/steps/sync ───────────────────────────────────────────────
const stepSyncSchema = z.object({
  dailySteps: z.number().int().min(0),
  verifiedSteps: z.number().int().min(0).optional(),
  stepDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  calories: z.number().optional(),
  distanceMeters: z.number().optional(),
});

router.post("/groups/steps/sync", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = stepSyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const { dailySteps, verifiedSteps, stepDate, calories, distanceMeters } = parsed.data;
  req.log.info({ userId, dailySteps, stepDate }, "[Groups] step sync");

  // Find all active groups for this user
  const memberships = await db
    .select({ groupId: walkingGroupMembersTable.groupId })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.userId, userId), eq(walkingGroupMembersTable.status, "active")));

  const groupIds = memberships.map((m) => m.groupId);
  if (!groupIds.length) return res.json({ success: true, updatedGroups: 0 });

  // Verify groups are active
  const activeGroups = await db
    .select({ id: walkingGroupsTable.id, dailyGoalSteps: walkingGroupsTable.dailyGoalSteps })
    .from(walkingGroupsTable)
    .where(and(inArray(walkingGroupsTable.id, groupIds), eq(walkingGroupsTable.status, "active")));

  const now = new Date();

  for (const group of activeGroups) {
    await db
      .insert(walkingGroupDailyStepsTable)
      .values({
        groupId: group.id,
        userId,
        stepDate,
        dailySteps,
        verifiedSteps: verifiedSteps ?? dailySteps,
        calories: calories?.toString() ?? null,
        distanceMeters: distanceMeters?.toString() ?? null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          walkingGroupDailyStepsTable.groupId,
          walkingGroupDailyStepsTable.userId,
          walkingGroupDailyStepsTable.stepDate,
        ],
        set: {
          dailySteps,
          verifiedSteps: verifiedSteps ?? dailySteps,
          calories: calories?.toString() ?? null,
          distanceMeters: distanceMeters?.toString() ?? null,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });

    // Broadcast update (fire-and-forget)
    broadcastGroupSteps(group.id, stepDate).catch(() => {});
  }

  return res.json({ success: true, updatedGroups: activeGroups.length });
});

// ── POST /api/groups/:groupId/archive ─────────────────────────────────────────
router.post("/groups/:groupId/archive", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group) return res.status(404).json({ error: "Group not found" });
  if (group.adminUserId !== userId) return res.status(403).json({ error: "Admin only" });

  await db
    .update(walkingGroupsTable)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(walkingGroupsTable.id, groupId));

  req.log.info({ groupId, userId }, "[Groups] group archived");
  return res.json({ success: true });
});

// ── POST /api/groups/:groupId/image ───────────────────────────────────────────
router.post("/groups/:groupId/image", requireAuth, groupImageUploadLimiter, upload.single("image"), async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No image provided" });
  if (!isObjectStorageConfigured()) return res.status(503).json({ error: "Group image storage is not configured" });

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });
  if (group.adminUserId !== userId) return res.status(403).json({ error: "Admin only" });

  try {
    const contentType = validateRasterUpload(file);
    const oldKey = objectKeyFromUrl(group.groupImageUrl);
    const objKey = buildGeneratedObjectKey("group-images", groupId, contentType);
    if (oldKey) {
      await deleteStoredObject(oldKey).catch(() => {});
    }
    await putStoredObject(objKey, file.buffer, contentType, {
      cacheControl: "public, max-age=31536000, immutable",
    });
    const imageUrl = objectUrl(objKey);
    const displayUrl = `/api/groups/${groupId}/image`;

    await db
      .update(walkingGroupsTable)
      .set({ groupImageUrl: imageUrl, updatedAt: new Date() })
      .where(eq(walkingGroupsTable.id, groupId));

    req.log.info({ groupId, userId }, "[Groups] group image uploaded");
    triggerEvent(`public-group-${groupId}`, "group.image.updated", { groupId, displayUrl }).catch(() => {});

    return res.json({ success: true, imageUrl, displayUrl });
  } catch (err) {
    if (isObjectStorageConfigError(err)) {
      return res.status(503).json({ error: "Group image storage is not configured" });
    }
    req.log.error(err, "[Groups] group image upload failed");
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ── GET /api/groups/:groupId/image ────────────────────────────────────────────
router.get("/groups/:groupId/image", async (req, res) => {
  const groupId = String(req.params.groupId);
  if (!isObjectStorageConfigured()) return res.status(503).end();
  try {
    const [group] = await db
      .select({ groupImageUrl: walkingGroupsTable.groupImageUrl })
      .from(walkingGroupsTable)
      .where(eq(walkingGroupsTable.id, groupId))
      .limit(1);
    const objKey = objectKeyFromUrl(group?.groupImageUrl);
    if (!objKey) return res.status(404).end();

    await proxyStoredObjectResponse(req, res, {
      routeName: "group-image",
      objectKey: objKey,
      maxBytes: config.runtime.uploadBodyLimitBytes,
      cacheControl: req.query.v
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
    });
    return;
  } catch (err) {
    if (isObjectStorageConfigError(err)) {
      return res.status(503).end();
    }
    return res.status(404).end();
  }
});

// ── GET /api/groups/:groupId/public ───────────────────────────────────────────
router.get("/groups/:groupId/public", requireAuth, async (req, res) => {
  const userId  = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db
    .select()
    .from(walkingGroupsTable)
    .where(eq(walkingGroupsTable.id, groupId))
    .limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });

  const memberCount = await getActiveGroupMembersCount(groupId);

  const today = todayUtc();

  const [todayRow] = await db
    .select({ totalSteps: sql<number>`coalesce(sum(daily_steps), 0)::int` })
    .from(walkingGroupDailyStepsTable)
    .where(and(
      eq(walkingGroupDailyStepsTable.groupId, groupId),
      sql`step_date = ${today}::date`,
    ));
  const todaySteps = todayRow?.totalSteps ?? 0;

  const [activeTodayRow] = await db
    .select({ count: sql<number>`count(distinct user_id)::int` })
    .from(walkingGroupDailyStepsTable)
    .where(and(
      eq(walkingGroupDailyStepsTable.groupId, groupId),
      sql`step_date = ${today}::date`,
      sql`daily_steps > 0`,
    ));
  const activeMembersToday = activeTodayRow?.count ?? 0;

  const [membership] = await db
    .select({ role: walkingGroupMembersTable.role, status: walkingGroupMembersTable.status })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.userId, userId)))
    .limit(1);

  const membershipStatus = membership?.status ?? "none";
  const isMember         = membership?.status === "active";
  const isAdmin          = isMember && membership?.role === "admin";

  let joinRequestStatus: string | null = null;
  let joinRequestId: string | null     = null;
  if (!isMember) {
    const [jr] = await db
      .select({ id: walkingGroupJoinRequestsTable.id, status: walkingGroupJoinRequestsTable.status })
      .from(walkingGroupJoinRequestsTable)
      .where(and(
        eq(walkingGroupJoinRequestsTable.groupId, groupId),
        eq(walkingGroupJoinRequestsTable.userId, userId),
      ))
      .orderBy(desc(walkingGroupJoinRequestsTable.createdAt))
      .limit(1);
    if (jr) { joinRequestStatus = jr.status; joinRequestId = jr.id; }
  }

  const canRequestToJoin = !isMember && joinRequestStatus !== "pending";
  const canViewGroup     = isMember;

  const dailyGoal       = group.dailyGoalSteps;
  const progressPercent = dailyGoal > 0 ? Math.min(100, Math.round((todaySteps / dailyGoal) * 100)) : 0;

  return res.json({
    group: {
      id: group.id,
      name: group.groupName,
      imageUrl: group.groupImageUrl ? `/api/groups/${group.id}/image` : null,
      type: group.groupType,
      categoryLabel: group.groupType === "custom" && group.customGroupType
        ? group.customGroupType
        : group.groupType.charAt(0).toUpperCase() + group.groupType.slice(1),
      memberCount,
      activeMembersToday,
      todaySteps,
      dailyGoal,
      progressPercent,
    },
    viewer: {
      membershipStatus,
      joinRequestStatus,
      joinRequestId,
      canRequestToJoin,
      canViewGroup,
      isAdmin,
    },
  });
});

// ── POST /api/groups/:groupId/join-request ────────────────────────────────────
router.post("/groups/:groupId/join-request", requireAuth, async (req, res) => {
  const userId  = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status !== "active") return res.status(404).json({ error: "Group not found" });

  const [existingMembership] = await db
    .select({ status: walkingGroupMembersTable.status })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.groupId, groupId), eq(walkingGroupMembersTable.userId, userId)))
    .limit(1);
  if (existingMembership?.status === "active") return res.status(409).json({ error: "Already a member" });

  const [existingRequest] = await db
    .select({ id: walkingGroupJoinRequestsTable.id, status: walkingGroupJoinRequestsTable.status })
    .from(walkingGroupJoinRequestsTable)
    .where(and(
      eq(walkingGroupJoinRequestsTable.groupId, groupId),
      eq(walkingGroupJoinRequestsTable.userId, userId),
    ))
    .orderBy(desc(walkingGroupJoinRequestsTable.createdAt))
    .limit(1);

  if (existingRequest?.status === "pending") {
    return res.status(409).json({ error: "Request already pending", requestId: existingRequest.id });
  }

  const [request] = await db
    .insert(walkingGroupJoinRequestsTable)
    .values({ id: crypto.randomUUID(), groupId, userId, status: "pending" })
    .returning();

  req.log.info({ groupId, userId }, "[Groups] join request created");

  const requesterUsername = await getUsername(userId);
  void notifyWalkingGroupJoinRequestReceived({
    walkingGroupId: groupId,
    walkingGroupName: group.groupName,
    walkingGroupJoinRequestId: request.id,
    requesterUserId: userId,
    requesterUsername,
  });
  triggerEvent(`private-user-${group.adminUserId}`, "group.join_request", {
    groupId,
    requestId: request.id,
  }).catch(() => {});

  return res.status(201).json({ success: true, requestId: request.id });
});

// ── POST /api/groups/join-requests/:requestId/accept ─────────────────────────
router.post("/groups/join-requests/:requestId/accept", requireAuth, async (req, res) => {
  const userId    = (req as AuthenticatedRequest).descopeUserId;
  const requestId = String(req.params.requestId);

  const [jr] = await db
    .select()
    .from(walkingGroupJoinRequestsTable)
    .where(eq(walkingGroupJoinRequestsTable.id, requestId))
    .limit(1);
  if (!jr) return res.status(404).json({ error: "Join request not found" });
  if (jr.status !== "pending") return res.status(409).json({ error: "Request is no longer pending" });

  const [adminMembership] = await db
    .select({ role: walkingGroupMembersTable.role })
    .from(walkingGroupMembersTable)
    .where(and(
      eq(walkingGroupMembersTable.groupId, jr.groupId),
      eq(walkingGroupMembersTable.userId, userId),
      eq(walkingGroupMembersTable.status, "active"),
    ))
    .limit(1);
  if (!adminMembership || adminMembership.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  const [existingMember] = await db
    .select({ status: walkingGroupMembersTable.status })
    .from(walkingGroupMembersTable)
    .where(and(eq(walkingGroupMembersTable.groupId, jr.groupId), eq(walkingGroupMembersTable.userId, jr.userId)))
    .limit(1);

  const now = new Date();
  if (!existingMember) {
    await db.insert(walkingGroupMembersTable).values({
      groupId: jr.groupId,
      userId: jr.userId,
      role: "member",
      status: "active",
      joinedAt: now,
    });
  } else if (existingMember.status !== "active") {
    await db
      .update(walkingGroupMembersTable)
      .set({ status: "active", joinedAt: now })
      .where(and(eq(walkingGroupMembersTable.groupId, jr.groupId), eq(walkingGroupMembersTable.userId, jr.userId)));
  }

  await db
    .update(walkingGroupJoinRequestsTable)
    .set({ status: "accepted", respondedByUserId: userId, respondedAt: now, updatedAt: now })
    .where(eq(walkingGroupJoinRequestsTable.id, requestId));

  req.log.info({ requestId, groupId: jr.groupId, newMemberId: jr.userId }, "[Groups] join request accepted");

  const [group] = await db
    .select({ groupName: walkingGroupsTable.groupName })
    .from(walkingGroupsTable)
    .where(eq(walkingGroupsTable.id, jr.groupId))
    .limit(1);

  triggerEvent(`private-user-${jr.userId}`, "group.join_request_accepted", { groupId: jr.groupId }).catch(() => {});
  void notifyWalkingGroupRequestAccepted({
    walkingGroupId: jr.groupId,
    walkingGroupName: group?.groupName ?? "the group",
    walkingGroupJoinRequestId: requestId,
    acceptedUserId: jr.userId,
    acceptedByAdminUserId: userId,
  });
  evaluateAndNotify(jr.userId).catch(() => {});

  return res.json({ success: true });
});

// ── POST /api/groups/join-requests/:requestId/reject ─────────────────────────
router.post("/groups/join-requests/:requestId/reject", requireAuth, async (req, res) => {
  const userId    = (req as AuthenticatedRequest).descopeUserId;
  const requestId = String(req.params.requestId);

  const [jr] = await db
    .select()
    .from(walkingGroupJoinRequestsTable)
    .where(eq(walkingGroupJoinRequestsTable.id, requestId))
    .limit(1);
  if (!jr) return res.status(404).json({ error: "Join request not found" });
  if (jr.status !== "pending") return res.status(409).json({ error: "Request is no longer pending" });

  const [adminMembership] = await db
    .select({ role: walkingGroupMembersTable.role })
    .from(walkingGroupMembersTable)
    .where(and(
      eq(walkingGroupMembersTable.groupId, jr.groupId),
      eq(walkingGroupMembersTable.userId, userId),
      eq(walkingGroupMembersTable.status, "active"),
    ))
    .limit(1);
  if (!adminMembership || adminMembership.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  const now = new Date();
  await db
    .update(walkingGroupJoinRequestsTable)
    .set({ status: "rejected", respondedByUserId: userId, respondedAt: now, updatedAt: now })
    .where(eq(walkingGroupJoinRequestsTable.id, requestId));

  req.log.info({ requestId, groupId: jr.groupId }, "[Groups] join request rejected");

  const [group] = await db
    .select({ groupName: walkingGroupsTable.groupName })
    .from(walkingGroupsTable)
    .where(eq(walkingGroupsTable.id, jr.groupId))
    .limit(1);

  triggerEvent(`private-user-${jr.userId}`, "group.join_request_rejected", { groupId: jr.groupId }).catch(() => {});
  void notifyWalkingGroupRequestRejected({
    walkingGroupId: jr.groupId,
    walkingGroupName: group?.groupName ?? "the group",
    walkingGroupJoinRequestId: requestId,
    requesterUserId: jr.userId,
  });

  return res.json({ success: true });
});

// ── DELETE /api/groups/:groupId ───────────────────────────────────────────────
router.delete("/groups/:groupId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const groupId = String(req.params.groupId);

  const [group] = await db.select().from(walkingGroupsTable).where(eq(walkingGroupsTable.id, groupId)).limit(1);
  if (!group || group.status === "deleted") return res.status(404).json({ error: "Group not found" });
  if (group.adminUserId !== userId) return res.status(403).json({ error: "Admin only" });

  await db
    .update(walkingGroupsTable)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(walkingGroupsTable.id, groupId));

  await db
    .update(walkingGroupMembersTable)
    .set({ status: "removed", removedAt: new Date() })
    .where(eq(walkingGroupMembersTable.groupId, groupId));

  req.log.info({ groupId, userId }, "[Groups] group deleted");
  triggerEvent(`public-group-${groupId}`, "group.deleted", { groupId }).catch(() => {});
  const oldKey = objectKeyFromUrl(group.groupImageUrl);
  if (oldKey) {
    deleteStoredObject(oldKey).catch(() => {});
  }

  return res.json({ success: true });
});

export default router;
