import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  authSessionsTable,
  integrityChallengesTable,
  raceAdjudicationEventsTable,
  raceParticipantsTable,
  raceResultEvidenceTable,
  raceRoomsTable,
  raceStepSyncLogsTable,
  raceVerificationSessionsTable,
} from "../../db/src/schema/index.js";
import { config } from "./config.js";
import { recordOutboxEvent } from "./outbox.js";
import {
  PROTECTED_ADJUDICATION,
  canonicalPayloadHash,
  classifyOffline,
  classifyContinuity,
  classifyReconciliation,
  closeResultGroups,
  closeResultThreshold,
  protectedPolicyFromStored,
} from "./protectedRacePolicy.js";
import { classifyIntegrityChallenge, verifyProtectedIntegrity, type ProtectedIntegrityProvider } from "./protectedRaceIntegrity.js";

export class ProtectedRaceError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function challengeHash(challenge: string): string {
  return createHash("sha256").update(challenge, "utf8").digest("base64url");
}

function platformContract(platform: "android" | "ios") {
  return platform === "android"
    ? { healthPlatform: "health_connect", source: "health_connect", integrityProvider: "android_play_integrity" as const }
    : { healthPlatform: "healthkit", source: "healthkit", integrityProvider: "ios_app_attest" as const };
}

async function issueChallenge(input: {
  verificationSessionId: string;
  raceId: string;
  userId: string;
  registeredDeviceId: string;
  purpose: "preflight" | "final_evidence";
}) {
  const serverChallenge = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.protectedRace.challengeTtlMs);
  const [row] = await db.insert(integrityChallengesTable).values({
    verificationSessionId: input.verificationSessionId,
    raceId: input.raceId,
    userId: input.userId,
    registeredDeviceId: input.registeredDeviceId,
    purpose: input.purpose,
    challengeHash: challengeHash(serverChallenge),
    expiresAt,
  }).returning();
  return { challengeId: row.id, serverChallenge, expiresAt };
}

export async function createProtectedVerificationSession(input: {
  raceId: string;
  userId: string;
  authSessionId: string | null | undefined;
  registeredDeviceId: string | null | undefined;
  platform: "android" | "ios";
  appVersion?: string | null;
  buildNumber?: string | null;
}) {
  if (!input.authSessionId || !input.registeredDeviceId) {
    throw new ProtectedRaceError(428, "PROTECTED_DEVICE_SESSION_REQUIRED", "A registered app session and device are required for this prize race.");
  }
  const [[room], [participant]] = await Promise.all([
    db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, input.raceId)).limit(1),
    db.select().from(raceParticipantsTable).where(and(
      eq(raceParticipantsTable.raceRoomId, input.raceId),
      eq(raceParticipantsTable.userId, input.userId),
      inArray(raceParticipantsTable.status, ["joined", "active"]),
    )).limit(1),
  ]);
  if (!room) throw new ProtectedRaceError(404, "RACE_NOT_FOUND", "Race not found.");
  if (!room.protectedRace) throw new ProtectedRaceError(409, "RACE_NOT_PROTECTED", "This race does not require protected verification.");
  if (!participant) throw new ProtectedRaceError(404, "PARTICIPANT_NOT_FOUND", "Participant not found.");
  if (!["open", "full", "scheduled"].includes(room.status)) {
    throw new ProtectedRaceError(409, "PROTECTED_PREFLIGHT_CLOSED", "Protected-race preflight must complete before the race starts.");
  }
  const contract = platformContract(input.platform);
  const [registeredAuthSession] = await db.select({
    deviceId: authSessionsTable.deviceId,
    platform: authSessionsTable.platform,
  }).from(authSessionsTable).where(and(
    eq(authSessionsTable.sessionId, input.authSessionId),
    eq(authSessionsTable.userId, input.userId),
    eq(authSessionsTable.status, "active"),
  )).limit(1);
  if (!registeredAuthSession || !registeredAuthSession.deviceId || registeredAuthSession.deviceId !== input.registeredDeviceId) {
    throw new ProtectedRaceError(409, "PROTECTED_REGISTERED_DEVICE_MISMATCH", "The active app session is not registered to this installation.");
  }
  if (registeredAuthSession.platform && registeredAuthSession.platform.toLowerCase() !== input.platform) {
    throw new ProtectedRaceError(409, "PROTECTED_PLATFORM_MISMATCH", "The registered app platform does not match this verification session.");
  }
  const [existing] = await db.select().from(raceVerificationSessionsTable).where(and(
    eq(raceVerificationSessionsTable.raceId, input.raceId),
    eq(raceVerificationSessionsTable.userId, input.userId),
  )).limit(1);
  if (existing && (
    existing.authSessionId !== input.authSessionId
    || existing.registeredDeviceId !== input.registeredDeviceId
    || existing.platform !== input.platform
    || existing.approvedSource !== contract.source
  )) {
    await db.transaction(async (tx) => {
      await tx.update(raceVerificationSessionsTable).set({
        continuityStatus: "USER_CONTINUITY_BREACH",
        reviewReasons: ["CONTINUITY_REVIEW"],
        updatedAt: new Date(),
      }).where(eq(raceVerificationSessionsTable.id, existing.id));
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId: input.raceId,
        participantId: participant.id,
        verificationSessionId: existing.id,
        eventType: "continuity_breach",
        oldDecision: existing.continuityStatus,
        newDecision: "USER_CONTINUITY_BREACH",
        reasonCode: "device_or_session_changed_before_start",
        actorType: "system",
      });
    });
    throw new ProtectedRaceError(409, "PROTECTED_SESSION_BINDING_MISMATCH", "This race is already bound to another registered installation.");
  }

  let session = existing;
  if (!session) {
    [session] = await db.insert(raceVerificationSessionsTable).values({
      raceId: input.raceId,
      participantId: participant.id,
      userId: input.userId,
      authSessionId: input.authSessionId,
      registeredDeviceId: input.registeredDeviceId,
      platform: input.platform,
      approvedHealthPlatform: contract.healthPlatform,
      approvedSource: contract.source,
      appVersion: input.appVersion ?? null,
      buildNumber: input.buildNumber ?? null,
    }).onConflictDoNothing().returning();
    if (!session) {
      [session] = await db.select().from(raceVerificationSessionsTable).where(and(
        eq(raceVerificationSessionsTable.raceId, input.raceId),
        eq(raceVerificationSessionsTable.userId, input.userId),
      )).limit(1);
    }
  }
  if (!session || session.authSessionId !== input.authSessionId
    || session.registeredDeviceId !== input.registeredDeviceId || session.platform !== input.platform) {
    throw new ProtectedRaceError(409, "PROTECTED_SESSION_BINDING_MISMATCH", "This race is already bound to another registered installation.");
  }

  const challenge = await issueChallenge({
    verificationSessionId: session.id,
    raceId: input.raceId,
    userId: input.userId,
    registeredDeviceId: input.registeredDeviceId,
    purpose: "preflight",
  });
  return {
    verificationSessionId: session.id,
    registeredDeviceId: session.registeredDeviceId,
    approvedHealthPlatform: session.approvedHealthPlatform,
    approvedSource: session.approvedSource,
    integrityProvider: contract.integrityProvider,
    ...challenge,
  };
}

async function loadChallenge(input: { challengeId: string; serverChallenge: string; sessionId: string; raceId: string; userId: string }) {
  const [row] = await db.select().from(integrityChallengesTable).where(and(
    eq(integrityChallengesTable.id, input.challengeId),
    eq(integrityChallengesTable.verificationSessionId, input.sessionId),
    eq(integrityChallengesTable.raceId, input.raceId),
    eq(integrityChallengesTable.userId, input.userId),
  )).limit(1);
  const failure = classifyIntegrityChallenge({
    existsAndBound: Boolean(row),
    challengeHashMatches: Boolean(row && row.challengeHash === challengeHash(input.serverChallenge)),
    consumedAt: row?.consumedAt ?? null,
    expiresAt: row?.expiresAt ?? null,
  });
  if (failure === "INTEGRITY_CHALLENGE_INVALID") throw new ProtectedRaceError(400, failure, "Integrity challenge is invalid.");
  if (failure === "INTEGRITY_CHALLENGE_REPLAYED") throw new ProtectedRaceError(409, failure, "Integrity challenge has already been used.");
  if (failure === "INTEGRITY_CHALLENGE_EXPIRED") throw new ProtectedRaceError(409, failure, "Integrity challenge has expired.");
  if (!row) throw new ProtectedRaceError(400, "INTEGRITY_CHALLENGE_INVALID", "Integrity challenge is invalid.");
  return row;
}

export async function attestProtectedPreflight(input: {
  raceId: string; userId: string; verificationSessionId: string; challengeId: string;
  serverChallenge: string; requestHash: string; provider: ProtectedIntegrityProvider; token: string;
  authSessionId?: string | null; registeredDeviceId?: string | null;
  approvedSource: "health_connect" | "healthkit"; permissionStatus: "granted";
}) {
  const [session] = await db.select().from(raceVerificationSessionsTable).where(and(
    eq(raceVerificationSessionsTable.id, input.verificationSessionId),
    eq(raceVerificationSessionsTable.raceId, input.raceId),
    eq(raceVerificationSessionsTable.userId, input.userId),
  )).limit(1);
  if (!session) throw new ProtectedRaceError(404, "VERIFICATION_SESSION_NOT_FOUND", "Verification session not found.");
  if (session.authSessionId !== input.authSessionId || session.registeredDeviceId !== input.registeredDeviceId) {
    throw new ProtectedRaceError(409, "PROTECTED_SESSION_BINDING_MISMATCH", "Registered session or device changed.");
  }
  const contract = platformContract(session.platform as "android" | "ios");
  if (input.provider !== contract.integrityProvider || input.approvedSource !== session.approvedSource) {
    throw new ProtectedRaceError(400, "PROTECTED_PLATFORM_CONTRACT_MISMATCH", "Integrity provider or approved health source does not match the registered platform.");
  }
  const challenge = await loadChallenge({ ...input, sessionId: session.id });
  if (challenge.purpose !== "preflight") throw new ProtectedRaceError(400, "INTEGRITY_CHALLENGE_PURPOSE_INVALID", "Wrong integrity challenge purpose.");
  const expectedHash = canonicalPayloadHash({
    approvedSource: session.approvedSource,
    permissionStatus: input.permissionStatus,
    participantId: session.participantId,
    platform: session.platform,
    purpose: "preflight",
    raceId: session.raceId,
    registeredDeviceId: session.registeredDeviceId,
    serverChallenge: input.serverChallenge,
    verificationSessionId: session.id,
  });
  if (input.requestHash !== expectedHash) throw new ProtectedRaceError(400, "INTEGRITY_REQUEST_HASH_MISMATCH", "Request hash does not match the server payload.");
  const verdict = await verifyProtectedIntegrity({ provider: input.provider, token: input.token, expectedRequestHash: expectedHash });
  if (!verdict.ok) {
    await db.transaction(async (tx) => {
      if (!verdict.retryable) {
        await tx.update(integrityChallengesTable).set({ consumedAt: new Date(), expectedRequestHash: expectedHash })
          .where(and(eq(integrityChallengesTable.id, challenge.id), isNull(integrityChallengesTable.consumedAt)));
      }
      await tx.update(raceVerificationSessionsTable).set({
        integrityStatus: verdict.retryable ? "pending" : "failed",
        reviewReasons: verdict.retryable ? [] : ["INTEGRITY_REVIEW"],
        updatedAt: new Date(),
      }).where(eq(raceVerificationSessionsTable.id, session.id));
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId: session.raceId, participantId: session.participantId, verificationSessionId: session.id,
        eventType: "integrity_failed", oldDecision: session.integrityStatus,
        newDecision: verdict.retryable ? "pending" : "INTEGRITY_REVIEW", reasonCode: verdict.code,
        actorType: "system", metadata: verdict.details ?? null,
      });
    });
    throw new ProtectedRaceError(verdict.retryable ? 503 : 409, verdict.code, "Device integrity verification failed.");
  }
  await db.transaction(async (tx) => {
    const consumed = await tx.update(integrityChallengesTable).set({ consumedAt: new Date(), expectedRequestHash: expectedHash })
      .where(and(eq(integrityChallengesTable.id, challenge.id), isNull(integrityChallengesTable.consumedAt), gt(integrityChallengesTable.expiresAt, new Date())))
      .returning({ id: integrityChallengesTable.id });
    if (consumed.length === 0) throw new ProtectedRaceError(409, "INTEGRITY_CHALLENGE_REPLAYED", "Integrity challenge was already used.");
    await tx.update(raceVerificationSessionsTable).set({
      integrityStatus: "passed", permissionStatus: input.permissionStatus,
      lastContactAt: new Date(), updatedAt: new Date(),
    })
      .where(eq(raceVerificationSessionsTable.id, session.id));
    await tx.insert(raceAdjudicationEventsTable).values({
      raceId: session.raceId, participantId: session.participantId, verificationSessionId: session.id,
      eventType: "preflight_verified", oldDecision: session.integrityStatus, newDecision: "passed",
      reasonCode: "integrity_verified", actorType: "system", evidenceReference: verdict.reference,
    });
  });
  return { verified: true, verificationSessionId: session.id };
}

export async function assertProtectedRaceReadyToStart(raceId: string): Promise<void> {
  const [room] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, raceId)).limit(1);
  if (!room?.protectedRace) return;
  const participants = await db.select({ id: raceParticipantsTable.id, userId: raceParticipantsTable.userId })
    .from(raceParticipantsTable).where(and(eq(raceParticipantsTable.raceRoomId, raceId), inArray(raceParticipantsTable.status, ["joined", "active"])));
  const sessions = await db.select().from(raceVerificationSessionsTable).where(eq(raceVerificationSessionsTable.raceId, raceId));
  const ready = new Set(sessions.filter((s) => s.integrityStatus === "passed"
    && s.continuityStatus === "HEALTHY" && s.permissionStatus === "granted" && s.sourceStable).map((s) => s.userId));
  const missing = participants.filter((p) => !ready.has(p.userId)).map((p) => p.userId);
  if (missing.length > 0) {
    throw new ProtectedRaceError(409, "PROTECTED_PREFLIGHT_INCOMPLETE", "Every participant must complete protected-race preflight before start.");
  }
}

export async function bindProtectedSessionsToRaceWindow(raceId: string, serverStartAt: Date, serverEndAt: Date): Promise<void> {
  await db.update(raceVerificationSessionsTable).set({ serverStartAt, serverEndAt, lastContactAt: serverStartAt, updatedAt: serverStartAt })
    .where(eq(raceVerificationSessionsTable.raceId, raceId));
}

export async function recordProtectedHeartbeat(input: {
  raceId: string; userId: string; verificationSessionId?: string | null;
  authSessionId?: string | null; registeredDeviceId?: string | null;
  approvedSource?: string | null; permissionStatus?: string | null;
}): Promise<void> {
  if (!input.verificationSessionId) return;
  const [session] = await db.select().from(raceVerificationSessionsTable).where(and(
    eq(raceVerificationSessionsTable.id, input.verificationSessionId),
    eq(raceVerificationSessionsTable.raceId, input.raceId),
    eq(raceVerificationSessionsTable.userId, input.userId),
  )).limit(1);
  if (!session) throw new ProtectedRaceError(404, "VERIFICATION_SESSION_NOT_FOUND", "Protected verification session not found.");
  const now = new Date();
  const contactAt = session.serverEndAt && now > session.serverEndAt ? session.serverEndAt : now;
  if (session.lastContactAt >= contactAt) return;
  const gapMs = Math.max(0, contactAt.getTime() - session.lastContactAt.getTime() - config.protectedRace.heartbeatIntervalMs);
  const bindingChanged = session.authSessionId !== input.authSessionId || session.registeredDeviceId !== input.registeredDeviceId;
  const sourceChanged = input.approvedSource != null && input.approvedSource !== session.approvedSource;
  const permissionRevoked = input.permissionStatus === "revoked" || input.permissionStatus === "denied";
  const continuity = classifyContinuity({ bindingChanged, sourceChanged, permissionStatus: input.permissionStatus });
  const reasons = new Set(session.reviewReasons ?? []);
  for (const reason of continuity.reviewReasons) reasons.add(reason);
  await db.transaction(async (tx) => {
    await tx.update(raceVerificationSessionsTable).set({
      lastContactAt: contactAt,
      cumulativeOfflineSeconds: session.cumulativeOfflineSeconds + Math.floor(gapMs / 1000),
      maxContinuousOfflineSeconds: Math.max(session.maxContinuousOfflineSeconds, Math.floor(gapMs / 1000)),
      continuityStatus: continuity.continuityStatus === "USER_CONTINUITY_BREACH" ? continuity.continuityStatus : session.continuityStatus,
      sourceStable: sourceChanged ? false : session.sourceStable,
      permissionStatus: input.permissionStatus ?? session.permissionStatus,
      reviewReasons: [...reasons],
      updatedAt: now,
    }).where(eq(raceVerificationSessionsTable.id, session.id));
    if (bindingChanged || sourceChanged || permissionRevoked) {
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId: session.raceId, participantId: session.participantId, verificationSessionId: session.id,
        eventType: "continuity_changed", oldDecision: session.continuityStatus,
        newDecision: bindingChanged || permissionRevoked ? "USER_CONTINUITY_BREACH" : "SOURCE_REVIEW",
        reasonCode: bindingChanged ? "registered_device_or_session_changed" : permissionRevoked ? "health_permission_revoked" : "approved_source_changed",
        actorType: "system",
      });
    }
  });
}

export async function createFinalEvidenceChallenge(input: {
  raceId: string; userId: string; verificationSessionId: string;
  authSessionId?: string | null; registeredDeviceId?: string | null;
}) {
  const [[room], [session]] = await Promise.all([
    db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, input.raceId)).limit(1),
    db.select().from(raceVerificationSessionsTable).where(and(
      eq(raceVerificationSessionsTable.id, input.verificationSessionId), eq(raceVerificationSessionsTable.raceId, input.raceId),
      eq(raceVerificationSessionsTable.userId, input.userId),
    )).limit(1),
  ]);
  if (!room?.protectedRace || !session) throw new ProtectedRaceError(404, "VERIFICATION_SESSION_NOT_FOUND", "Protected verification session not found.");
  if (session.authSessionId !== input.authSessionId || session.registeredDeviceId !== input.registeredDeviceId) {
    throw new ProtectedRaceError(409, "PROTECTED_SESSION_BINDING_MISMATCH", "Registered session or device changed.");
  }
  if (session.integrityStatus !== "passed") throw new ProtectedRaceError(409, "PROTECTED_PREFLIGHT_INCOMPLETE", "Device preflight has not passed.");
  const endAt = room.serverEndAt ?? session.serverEndAt;
  if (!endAt || Date.now() < endAt.getTime()) throw new ProtectedRaceError(409, "RACE_NOT_ENDED", "Final evidence is available after the server race end.");
  return issueChallenge({ verificationSessionId: session.id, raceId: input.raceId, userId: input.userId,
    registeredDeviceId: session.registeredDeviceId, purpose: "final_evidence" });
}

export type FinalEvidenceInput = {
  raceId: string; userId: string; verificationSessionId: string; challengeId: string; serverChallenge: string;
  registeredDeviceId: string; serverStartAt: string; serverEndAt: string; approvedSource: string;
  qualifyingSteps: number; provisionalSteps: number; verificationReadAt: string; evidenceHash: string;
  requestHash: string; integrityProvider: ProtectedIntegrityProvider; integrityToken: string;
  authSessionId?: string | null;
  sourceEvidence: { automaticRecordCount: number; manualEntryCount: number; sourceIds: string[]; recordingMethods: string[] };
};

export async function submitFinalProtectedEvidence(input: FinalEvidenceInput) {
  const [[room], [session], [participant]] = await Promise.all([
    db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, input.raceId)).limit(1),
    db.select().from(raceVerificationSessionsTable).where(and(eq(raceVerificationSessionsTable.id, input.verificationSessionId),
      eq(raceVerificationSessionsTable.raceId, input.raceId), eq(raceVerificationSessionsTable.userId, input.userId))).limit(1),
    db.select().from(raceParticipantsTable).where(and(eq(raceParticipantsTable.raceRoomId, input.raceId), eq(raceParticipantsTable.userId, input.userId))).limit(1),
  ]);
  if (!room?.protectedRace || !session || !participant) throw new ProtectedRaceError(404, "VERIFICATION_SESSION_NOT_FOUND", "Protected verification session not found.");
  if (session.authSessionId !== input.authSessionId || session.registeredDeviceId !== input.registeredDeviceId) {
    throw new ProtectedRaceError(409, "PROTECTED_SESSION_BINDING_MISMATCH", "Registered session or device changed.");
  }
  const [existingEvidence] = await db.select().from(raceResultEvidenceTable).where(and(
    eq(raceResultEvidenceTable.raceId, input.raceId),
    eq(raceResultEvidenceTable.participantId, participant.id),
  )).orderBy(desc(raceResultEvidenceTable.submittedAt)).limit(1);
  if (existingEvidence) {
    if (existingEvidence.evidenceHash !== input.evidenceHash) {
      throw new ProtectedRaceError(409, "FINAL_EVIDENCE_ALREADY_SUBMITTED", "Final evidence has already been submitted for this participant.");
    }
    return {
      accepted: true,
      replayed: true,
      evidenceId: existingEvidence.id,
      adjudication: await attemptProtectedRaceAdjudication(room.id),
    };
  }
  if (!session.serverStartAt || !session.serverEndAt || !room.serverEndAt) throw new ProtectedRaceError(409, "RACE_WINDOW_UNAVAILABLE", "Server race window is unavailable.");
  if (session.registeredDeviceId !== input.registeredDeviceId || session.approvedSource !== input.approvedSource) {
    throw new ProtectedRaceError(409, "PROTECTED_SESSION_BINDING_MISMATCH", "Device or approved source changed.");
  }
  const contract = platformContract(session.platform as "android" | "ios");
  if (input.integrityProvider !== contract.integrityProvider) {
    throw new ProtectedRaceError(400, "PROTECTED_PLATFORM_CONTRACT_MISMATCH", "Integrity provider does not match the registered platform.");
  }
  if (new Date(input.serverStartAt).getTime() !== session.serverStartAt.getTime()
    || new Date(input.serverEndAt).getTime() !== session.serverEndAt.getTime()) {
    throw new ProtectedRaceError(400, "RACE_WINDOW_MISMATCH", "Submitted race window does not match server timing.");
  }
  if (input.provisionalSteps !== participant.currentSteps) throw new ProtectedRaceError(409, "PROVISIONAL_STEPS_MISMATCH", "Provisional total does not match server progress.");
  const expectedEvidenceHash = canonicalPayloadHash(input.sourceEvidence as unknown as Record<string, unknown>);
  if (input.evidenceHash !== expectedEvidenceHash) throw new ProtectedRaceError(400, "EVIDENCE_HASH_MISMATCH", "Evidence metadata hash does not match.");
  const readAt = new Date(input.verificationReadAt);
  if (readAt.getTime() < room.serverEndAt.getTime() || readAt.getTime() > Date.now() + 5 * 60_000) {
    throw new ProtectedRaceError(400, "VERIFICATION_READ_TIME_INVALID", "Verification read time is outside the permitted window.");
  }
  const challenge = await loadChallenge({ ...input, sessionId: session.id });
  if (challenge.purpose !== "final_evidence") throw new ProtectedRaceError(400, "INTEGRITY_CHALLENGE_PURPOSE_INVALID", "Wrong integrity challenge purpose.");
  const expectedRequestHash = canonicalPayloadHash({
    approvedSource: session.approvedSource,
    evidenceHash: input.evidenceHash,
    participantId: participant.id,
    provisionalSteps: participant.currentSteps,
    qualifyingSteps: input.qualifyingSteps,
    raceId: room.id,
    registeredDeviceId: session.registeredDeviceId,
    serverChallenge: input.serverChallenge,
    serverEndAt: session.serverEndAt.toISOString(),
    serverStartAt: session.serverStartAt.toISOString(),
    verificationReadAt: readAt.toISOString(),
    verificationSessionId: session.id,
  });
  if (input.requestHash !== expectedRequestHash) throw new ProtectedRaceError(400, "INTEGRITY_REQUEST_HASH_MISMATCH", "Request hash does not match the server payload.");
  const integrity = await verifyProtectedIntegrity({ provider: input.integrityProvider, token: input.integrityToken, expectedRequestHash });
  if (!integrity.ok) {
    await db.transaction(async (tx) => {
      if (!integrity.retryable) {
        await tx.update(integrityChallengesTable).set({ consumedAt: new Date(), expectedRequestHash })
          .where(and(eq(integrityChallengesTable.id, challenge.id), isNull(integrityChallengesTable.consumedAt)));
      }
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId: room.id, participantId: participant.id, verificationSessionId: session.id,
        eventType: "final_integrity_failed", oldDecision: session.integrityStatus, newDecision: "INTEGRITY_REVIEW",
        reasonCode: integrity.code, actorType: "system", metadata: integrity.details ?? null,
      });
    });
    throw new ProtectedRaceError(integrity.retryable ? 503 : 409, integrity.code, "Final integrity verification failed.");
  }

  const policy = protectedPolicyFromStored(room.protectedPolicySnapshot);
  const reconciliationVerdict = classifyReconciliation(participant.currentSteps, input.qualifyingSteps, policy);
  const raceDurationMs = session.serverEndAt.getTime() - session.serverStartAt.getTime();
  const trailingContactAt = Math.min(Date.now(), session.serverEndAt.getTime());
  const trailingOfflineMs = Math.max(0, trailingContactAt - session.lastContactAt.getTime() - policy.heartbeatIntervalMs);
  const offlineVerdict = classifyOffline({
    maxContinuousOfflineMs: Math.max(session.maxContinuousOfflineSeconds * 1000, trailingOfflineMs),
    cumulativeOfflineMs: session.cumulativeOfflineSeconds * 1000 + trailingOfflineMs,
    raceDurationMs,
    policy,
  });
  const late = Date.now() > session.serverEndAt.getTime() + policy.finalEvidenceUploadGraceMs;
  const sourceVerdict = input.sourceEvidence.manualEntryCount > 0
    || input.sourceEvidence.automaticRecordCount <= 0
    || !session.sourceStable ? "SOURCE_REVIEW" : "CLEAR";
  const continuityVerdict = session.continuityStatus === "HEALTHY" && session.permissionStatus === "granted"
    ? "CLEAR" : "CONTINUITY_REVIEW";
  const riskSignals: string[] = [];
  if (late) riskSignals.push("LATE_FINAL_EVIDENCE");
  const sameDevice = await db.select({ userId: raceVerificationSessionsTable.userId }).from(raceVerificationSessionsTable).where(and(
    eq(raceVerificationSessionsTable.raceId, room.id), eq(raceVerificationSessionsTable.registeredDeviceId, session.registeredDeviceId),
    ne(raceVerificationSessionsTable.userId, input.userId),
  )).limit(1);
  if (sameDevice.length > 0) riskSignals.push("MULTIPLE_ACCOUNTS_SAME_PROTECTED_DEVICE");
  const [suspiciousProgress] = await db.select({ count: sql<number>`count(*)::int` })
    .from(raceStepSyncLogsTable).where(and(
      eq(raceStepSyncLogsTable.raceId, room.id),
      eq(raceStepSyncLogsTable.userId, input.userId),
      eq(raceStepSyncLogsTable.suspicious, true),
    ));
  if ((suspiciousProgress?.count ?? 0) > 0) riskSignals.push("SUSPICIOUS_PROVISIONAL_STEP_PATTERN");
  const fraudRiskVerdict = riskSignals.length > 0 ? "REVIEW_REQUIRED" : "CLEAR";

  const evidence = await db.transaction(async (tx) => {
    const consumed = await tx.update(integrityChallengesTable).set({ consumedAt: new Date(), expectedRequestHash })
      .where(and(eq(integrityChallengesTable.id, challenge.id), isNull(integrityChallengesTable.consumedAt), gt(integrityChallengesTable.expiresAt, new Date())))
      .returning({ id: integrityChallengesTable.id });
    if (consumed.length === 0) throw new ProtectedRaceError(409, "INTEGRITY_CHALLENGE_REPLAYED", "Integrity challenge was already used.");
    const evidenceValues: typeof raceResultEvidenceTable.$inferInsert = {
      raceId: room.id, participantId: participant.id, userId: input.userId, verificationSessionId: session.id,
      challengeId: challenge.id, platform: session.platform, appVersion: session.appVersion,
      registeredDeviceId: session.registeredDeviceId, serverStartAt: session.serverStartAt!, serverEndAt: session.serverEndAt!,
      approvedSource: session.approvedSource, qualifyingSteps: input.qualifyingSteps, provisionalSteps: participant.currentSteps,
      verificationReadAt: readAt, sourceVerdict, integrityVerdict: "CLEAR", continuityVerdict,
      reconciliationVerdict, fraudRiskVerdict, offlineVerdict, evidenceHash: input.evidenceHash,
      canonicalRequestHash: expectedRequestHash, integrityProvider: input.integrityProvider,
      integrityReference: integrity.reference, riskSignals,
      sourceEvidenceSummary: {
        automaticRecordCount: input.sourceEvidence.automaticRecordCount,
        manualEntryCount: input.sourceEvidence.manualEntryCount,
        sourceIdHashes: input.sourceEvidence.sourceIds.map((sourceId) => createHash("sha256").update(sourceId).digest("base64url")),
        recordingMethods: input.sourceEvidence.recordingMethods,
      },
    };
    const rows = await tx.insert(raceResultEvidenceTable).values(evidenceValues).onConflictDoNothing().returning();
    if (!rows[0]) throw new ProtectedRaceError(409, "EVIDENCE_REPLAYED", "This evidence was already submitted.");
    await tx.insert(raceAdjudicationEventsTable).values({
      raceId: room.id, participantId: participant.id, verificationSessionId: session.id,
      eventType: "final_evidence_submitted", oldDecision: room.adjudicationStatus,
      newDecision: "evidence_received", reasonCode: "attested_evidence_accepted", actorType: "system",
      evidenceReference: rows[0].id, metadata: { sourceVerdict, continuityVerdict, reconciliationVerdict, offlineVerdict, fraudRiskVerdict },
    });
    return rows[0];
  });
  const adjudication = await attemptProtectedRaceAdjudication(room.id);
  return { accepted: true, evidenceId: evidence.id, adjudication };
}

const RETRY_OFFSETS_MS = [0, 5, 15, 30, 60, 120, 240].map((minutes) => minutes * 60_000);

export async function scheduleProtectedAdjudicationRetries(raceId: string, serverEndAt: Date): Promise<void> {
  const [room] = await db.select({ protectedPolicySnapshot: raceRoomsTable.protectedPolicySnapshot })
    .from(raceRoomsTable).where(eq(raceRoomsTable.id, raceId)).limit(1);
  const reviewWindowMs = protectedPolicyFromStored(room?.protectedPolicySnapshot).reviewWindowMs;
  await Promise.all([...RETRY_OFFSETS_MS, reviewWindowMs].map((offset) => recordOutboxEvent({
    topic: "scheduled-jobs",
    eventType: "race.protected_adjudication_retry",
    aggregateType: "race",
    aggregateId: raceId,
    idempotencyKey: `protected-adjudication:${raceId}:${offset}`,
    payload: { raceId },
    availableAt: new Date(serverEndAt.getTime() + offset),
  })));
}

export async function attemptProtectedRaceAdjudication(raceId: string): Promise<{ ready: boolean; status: string; reasons: string[] }> {
  const [room] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, raceId)).limit(1);
  if (!room?.protectedRace) return { ready: true, status: "not_protected", reasons: [] };
  if (room.adjudicationStatus === PROTECTED_ADJUDICATION.FINALIZED) return { ready: true, status: "finalized", reasons: [] };
  if (room.adjudicationStatus === PROTECTED_ADJUDICATION.VOIDED) return { ready: false, status: "voided", reasons: room.adjudicationReasonCodes ?? [] };
  const endAt = room.serverEndAt;
  if (!endAt || Date.now() < endAt.getTime()) return { ready: false, status: "live", reasons: ["race_window_open"] };
  if (room.adjudicationStatus !== PROTECTED_ADJUDICATION.RECONCILING) {
    await db.update(raceRoomsTable).set({ adjudicationStatus: PROTECTED_ADJUDICATION.RECONCILING, updatedAt: new Date() })
      .where(and(eq(raceRoomsTable.id, raceId), ne(raceRoomsTable.adjudicationStatus, PROTECTED_ADJUDICATION.FINALIZED)));
  }
  const policy = protectedPolicyFromStored(room.protectedPolicySnapshot);
  const participants = await db.select().from(raceParticipantsTable).where(and(
    eq(raceParticipantsTable.raceRoomId, raceId),
    inArray(raceParticipantsTable.status, ["joined", "active", "completed"]),
  ));
  const allEvidence = await db.select().from(raceResultEvidenceTable).where(eq(raceResultEvidenceTable.raceId, raceId))
    .orderBy(desc(raceResultEvidenceTable.submittedAt));
  const participantIds = new Set(participants.map((participant) => participant.id));
  const evidence = allEvidence.filter((row) => participantIds.has(row.participantId));
  const adminVerificationEvents = await db.select().from(raceAdjudicationEventsTable).where(and(
    eq(raceAdjudicationEventsTable.raceId, raceId),
    eq(raceAdjudicationEventsTable.eventType, "admin_verify"),
  )).orderBy(desc(raceAdjudicationEventsTable.createdAt));
  const adminVerifiedSteps = new Map<string, number>();
  for (const event of adminVerificationEvents) {
    if (!event.participantId || adminVerifiedSteps.has(event.participantId)) continue;
    const steps = event.metadata?.qualifyingSteps;
    if (typeof steps === "number" && Number.isInteger(steps) && steps >= 0) adminVerifiedSteps.set(event.participantId, steps);
  }
  const byParticipant = new Map(evidence.map((e) => [e.participantId, e]));
  const missing = participants.filter((p) => !byParticipant.has(p.id));
  if (missing.length > 0) {
    const elapsed = Date.now() - endAt.getTime();
    const reviewExpired = elapsed > policy.reviewWindowMs;
    const status = reviewExpired ? PROTECTED_ADJUDICATION.VOIDED
      : elapsed > policy.verificationGraceMs ? PROTECTED_ADJUDICATION.REVIEW
      : PROTECTED_ADJUDICATION.PENDING;
    const reasons = [reviewExpired ? "unresolved_review_window_elapsed" : elapsed > policy.verificationGraceMs ? "verification_missing" : "awaiting_final_evidence"];
    if (reviewExpired) {
      const { createProtectedRaceVoidRefund } = await import("./refundService.js");
      await createProtectedRaceVoidRefund({ raceId, reasonCode: reasons[0] });
      await db.insert(raceAdjudicationEventsTable).values({
        raceId, eventType: "race_voided", oldDecision: room.adjudicationStatus,
        newDecision: status, reasonCode: reasons[0], actorType: "system",
        metadata: { missingParticipantIds: missing.map((p) => p.id) },
      });
      return { ready: false, status, reasons };
    }
    await db.transaction(async (tx) => {
      await tx.update(raceRoomsTable).set({
        status: "completed",
        completedAt: sql`coalesce(${raceRoomsTable.completedAt}, ${endAt})`,
        settlementStatus: elapsed > policy.verificationGraceMs ? "review_required" : "awaiting_verification",
        adjudicationStatus: status, adjudicationReasonCodes: reasons,
        updatedAt: new Date(),
      }).where(eq(raceRoomsTable.id, raceId));
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId, eventType: "adjudication_waiting",
        oldDecision: room.adjudicationStatus, newDecision: status, reasonCode: reasons[0], actorType: "system",
        metadata: { missingParticipantIds: missing.map((p) => p.id) },
      });
    });
    return { ready: false, status, reasons };
  }
  const reviewReasons = evidence.filter((e) => !adminVerifiedSteps.has(e.participantId)).flatMap((e) => [
    e.sourceVerdict, e.integrityVerdict, e.continuityVerdict, e.reconciliationVerdict, e.fraudRiskVerdict, e.offlineVerdict,
  ]).filter((v) => v !== "CLEAR");
  if (reviewReasons.length > 0) {
    if (Date.now() - endAt.getTime() > policy.reviewWindowMs) {
      const { createProtectedRaceVoidRefund } = await import("./refundService.js");
      await createProtectedRaceVoidRefund({ raceId, reasonCode: "unresolved_review_window_elapsed" });
      return { ready: false, status: PROTECTED_ADJUDICATION.VOIDED, reasons: ["unresolved_review_window_elapsed"] };
    }
    await db.update(raceRoomsTable).set({ status: "completed", completedAt: sql`coalesce(${raceRoomsTable.completedAt}, ${endAt})`,
      settlementStatus: "review_required", adjudicationStatus: PROTECTED_ADJUDICATION.REVIEW,
      adjudicationReasonCodes: [...new Set(reviewReasons)], updatedAt: new Date() }).where(eq(raceRoomsTable.id, raceId));
    return { ready: false, status: PROTECTED_ADJUDICATION.REVIEW, reasons: [...new Set(reviewReasons)] };
  }

  const standings = evidence.map((e) => ({
    userId: e.userId,
    qualifyingSteps: adminVerifiedSteps.get(e.participantId) ?? e.qualifyingSteps,
  }));
  const paidPositions = room.winnerSlotCount ?? 1;
  const groupByUser = closeResultGroups(standings, paidPositions, policy);
  const groupCounts = new Map<string, number>();
  for (const group of groupByUser.values()) groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  const sorted = [...standings].sort((a, b) => b.qualifyingSteps - a.qualifyingSteps || a.userId.localeCompare(b.userId));
  await db.transaction(async (tx) => {
    for (let i = 0; i < sorted.length; i++) {
      const standing = sorted[i];
      const participant = participants.find((p) => p.userId === standing.userId)!;
      const evidenceRow = evidence.find((e) => e.userId === standing.userId)!;
      const group = groupByUser.get(standing.userId)!;
      const next = sorted[i + 1];
      const margin = next ? standing.qualifyingSteps - next.qualifyingSteps : null;
      const threshold = next ? closeResultThreshold(next.qualifyingSteps, policy) : null;
      const tied = (groupCounts.get(group) ?? 0) > 1;
      await tx.update(raceParticipantsTable).set({
        verifiedCumulativeSteps: standing.qualifyingSteps,
        verificationSource: evidenceRow.approvedSource,
        reconciledSteps: standing.qualifyingSteps,
        reconciliationStatus: "finalized",
        reconciledAt: new Date(),
        reconciliationReasonCodes: tied ? ["protected_verified", "clean_close_result_tie"] : ["protected_verified"],
        protectedTieGroup: participant.protectedTieGroup?.startsWith("admin-")
          ? participant.protectedTieGroup
          : tied ? group : null,
      }).where(eq(raceParticipantsTable.id, participant.id));
      await tx.update(raceResultEvidenceTable).set({
        winningMargin: margin, closeResultThreshold: threshold, closeResultFlag: tied,
        closeResultGroup: tied ? group : null, finalizedAt: new Date(),
      }).where(eq(raceResultEvidenceTable.id, evidenceRow.id));
    }
    const finalized = await tx.update(raceRoomsTable).set({
      status: "completed", completedAt: sql`coalesce(${raceRoomsTable.completedAt}, ${endAt})`,
      settlementStatus: "awaiting_verification", adjudicationStatus: PROTECTED_ADJUDICATION.FINALIZED,
      adjudicationReasonCodes: [], adjudicationFinalizedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(raceRoomsTable.id, raceId), ne(raceRoomsTable.adjudicationStatus, PROTECTED_ADJUDICATION.FINALIZED)))
      .returning({ id: raceRoomsTable.id });
    if (finalized.length > 0) {
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId, eventType: "adjudication_finalized", oldDecision: room.adjudicationStatus,
        newDecision: PROTECTED_ADJUDICATION.FINALIZED, reasonCode: "all_evidence_clear", actorType: "system",
        metadata: { automaticTieGroups: [...groupCounts].filter(([, count]) => count > 1).map(([group]) => group) },
      });
    }
  });
  return { ready: true, status: PROTECTED_ADJUDICATION.FINALIZED, reasons: [] };
}

export async function getProtectedRaceReview(raceId: string) {
  const [room, participants, sessions, evidence, events] = await Promise.all([
    db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, raceId)).limit(1).then((r) => r[0] ?? null),
    db.select().from(raceParticipantsTable).where(eq(raceParticipantsTable.raceRoomId, raceId)),
    db.select().from(raceVerificationSessionsTable).where(eq(raceVerificationSessionsTable.raceId, raceId)),
    db.select().from(raceResultEvidenceTable).where(eq(raceResultEvidenceTable.raceId, raceId)).orderBy(desc(raceResultEvidenceTable.submittedAt)),
    db.select().from(raceAdjudicationEventsTable).where(eq(raceAdjudicationEventsTable.raceId, raceId)).orderBy(desc(raceAdjudicationEventsTable.createdAt)),
  ]);
  return { room, participants, sessions, evidence, events };
}

export async function resolveProtectedRaceAdmin(input: {
  raceId: string;
  action: "VERIFY" | "DISQUALIFY" | "VOID" | "MARK_TIE" | "RESTORE_ENTRY";
  adminUserId: string;
  reason: string;
  evidenceReference?: string | null;
  participantId?: string | null;
  qualifyingSteps?: number | null;
  tieUserIds?: string[];
}) {
  const [room] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, input.raceId)).limit(1);
  if (!room?.protectedRace) throw new ProtectedRaceError(404, "PROTECTED_RACE_NOT_FOUND", "Protected race not found.");
  if (room.settlementStatus === "paid") throw new ProtectedRaceError(409, "RACE_ALREADY_SETTLED", "A paid race cannot be changed.");

  if (input.action === "VOID") {
    const { createProtectedRaceVoidRefund } = await import("./refundService.js");
    const refundBatch = await createProtectedRaceVoidRefund({ raceId: input.raceId, reasonCode: input.reason });
    await db.insert(raceAdjudicationEventsTable).values({
      raceId: input.raceId, eventType: "admin_void", oldDecision: room.adjudicationStatus,
      newDecision: PROTECTED_ADJUDICATION.VOIDED, reasonCode: input.reason,
      actorType: "admin", actorUserId: input.adminUserId, evidenceReference: input.evidenceReference ?? null,
    });
    return { action: input.action, refundBatch };
  }

  if (input.action === "MARK_TIE") {
    const userIds = [...new Set(input.tieUserIds ?? [])];
    if (userIds.length < 2) throw new ProtectedRaceError(400, "TIE_PARTICIPANTS_REQUIRED", "At least two users are required to mark a tie.");
    const tieGroup = `admin-${randomBytes(8).toString("hex")}`;
    await db.transaction(async (tx) => {
      const changed = await tx.update(raceParticipantsTable).set({ protectedTieGroup: tieGroup })
        .where(and(eq(raceParticipantsTable.raceRoomId, input.raceId), inArray(raceParticipantsTable.userId, userIds)))
        .returning({ userId: raceParticipantsTable.userId });
      if (changed.length !== userIds.length) throw new ProtectedRaceError(400, "TIE_PARTICIPANT_INVALID", "Every tie user must be a race participant.");
      await tx.insert(raceAdjudicationEventsTable).values({
        raceId: input.raceId, eventType: "admin_mark_tie", oldDecision: room.adjudicationStatus,
        newDecision: "manual_tie", reasonCode: input.reason, actorType: "admin",
        actorUserId: input.adminUserId, evidenceReference: input.evidenceReference ?? null,
        metadata: { tieGroup, userIds },
      });
    });
    return { action: input.action, tieGroup, userIds };
  }

  if (!input.participantId) throw new ProtectedRaceError(400, "PARTICIPANT_REQUIRED", "A participant is required for this action.");
  const [participant] = await db.select().from(raceParticipantsTable).where(and(
    eq(raceParticipantsTable.id, input.participantId), eq(raceParticipantsTable.raceRoomId, input.raceId),
  )).limit(1);
  if (!participant) throw new ProtectedRaceError(404, "PARTICIPANT_NOT_FOUND", "Participant not found.");

  let resolvedQualifyingSteps: number | null = null;
  await db.transaction(async (tx) => {
    if (input.action === "DISQUALIFY") {
      await tx.update(raceParticipantsTable).set({ status: "disqualified", protectedTieGroup: null })
        .where(eq(raceParticipantsTable.id, participant.id));
    } else if (input.action === "RESTORE_ENTRY") {
      await tx.update(raceParticipantsTable).set({ status: "completed" })
        .where(eq(raceParticipantsTable.id, participant.id));
    } else {
      const [evidence] = await tx.select().from(raceResultEvidenceTable)
        .where(and(eq(raceResultEvidenceTable.raceId, input.raceId), eq(raceResultEvidenceTable.participantId, participant.id))).limit(1);
      if (!evidence) throw new ProtectedRaceError(409, "EVIDENCE_REQUIRED", "Evidence must exist before an admin can verify a participant.");
      const qualifyingSteps = input.qualifyingSteps ?? evidence.qualifyingSteps;
      resolvedQualifyingSteps = qualifyingSteps;
      await tx.update(raceParticipantsTable).set({
        verifiedCumulativeSteps: qualifyingSteps, reconciledSteps: qualifyingSteps,
        reconciliationStatus: "finalized", reconciliationReasonCodes: ["admin_verified"], reconciledAt: new Date(),
      }).where(eq(raceParticipantsTable.id, participant.id));
    }
    await tx.insert(raceAdjudicationEventsTable).values({
      raceId: input.raceId, participantId: participant.id,
      eventType: `admin_${input.action.toLowerCase()}`, oldDecision: participant.status,
      newDecision: input.action.toLowerCase(), reasonCode: input.reason,
      actorType: "admin", actorUserId: input.adminUserId, evidenceReference: input.evidenceReference ?? null,
      metadata: input.action === "VERIFY"
        ? { qualifyingSteps: resolvedQualifyingSteps }
        : null,
    });
  });
  return { action: input.action, participantId: participant.id, adjudication: await attemptProtectedRaceAdjudication(input.raceId) };
}
