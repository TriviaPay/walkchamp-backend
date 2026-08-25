import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import {
  ProtectedRaceError,
  attestProtectedPreflight,
  createFinalEvidenceChallenge,
  createProtectedVerificationSession,
  getProtectedRaceReview,
  recordProtectedHeartbeat,
  submitFinalProtectedEvidence,
} from "../lib/protectedRaceAdjudication.js";

const router = Router();

function sendError(res: import("express").Response, error: unknown) {
  if (error instanceof ProtectedRaceError) return res.status(error.status).json({ error: error.message, code: error.code });
  throw error;
}

const platformSchema = z.enum(["android", "ios"]);
const integritySchema = z.object({
  provider: z.enum(["android_play_integrity", "ios_app_attest"]),
  token: z.string().min(16).max(20000),
  requestHash: z.string().min(32).max(128),
});

router.post("/races/:id/protected-verification/session", requireAuth, async (req, res) => {
  const parsed = z.object({ platform: platformSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid protected-race preflight.", details: parsed.error.issues });
  const auth = req as AuthenticatedRequest;
  try {
    const result = await createProtectedVerificationSession({
      raceId: String(req.params.id), userId: auth.descopeUserId,
      authSessionId: auth.sessionId, registeredDeviceId: auth.deviceInfo?.deviceId,
      platform: parsed.data.platform, appVersion: auth.deviceInfo?.appVersion, buildNumber: auth.deviceInfo?.buildNumber,
    });
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/races/:id/protected-verification/preflight", requireAuth, async (req, res) => {
  const parsed = z.object({
    verificationSessionId: z.string().uuid(), challengeId: z.string().uuid(),
    serverChallenge: z.string().min(32).max(128), integrity: integritySchema,
    approvedSource: z.enum(["health_connect", "healthkit"]),
    permissionStatus: z.literal("granted"),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid integrity preflight.", details: parsed.error.issues });
  const auth = req as AuthenticatedRequest;
  try {
    return res.json(await attestProtectedPreflight({
      raceId: String(req.params.id), userId: auth.descopeUserId,
      verificationSessionId: parsed.data.verificationSessionId, challengeId: parsed.data.challengeId,
      serverChallenge: parsed.data.serverChallenge, requestHash: parsed.data.integrity.requestHash,
      provider: parsed.data.integrity.provider, token: parsed.data.integrity.token,
      authSessionId: auth.sessionId, registeredDeviceId: auth.deviceInfo?.deviceId,
      approvedSource: parsed.data.approvedSource, permissionStatus: parsed.data.permissionStatus,
    }));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/races/:id/protected-verification/heartbeat", requireAuth, async (req, res) => {
  const parsed = z.object({
    verificationSessionId: z.string().uuid(),
    approvedSource: z.enum(["health_connect", "healthkit"]),
    permissionStatus: z.enum(["granted", "revoked", "denied"]),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid protected-race heartbeat.", details: parsed.error.issues });
  const auth = req as AuthenticatedRequest;
  try {
    await recordProtectedHeartbeat({
      raceId: String(req.params.id), userId: auth.descopeUserId,
      verificationSessionId: parsed.data.verificationSessionId,
      authSessionId: auth.sessionId, registeredDeviceId: auth.deviceInfo?.deviceId,
      approvedSource: parsed.data.approvedSource, permissionStatus: parsed.data.permissionStatus,
    });
    return res.json({ accepted: true, serverTime: new Date().toISOString() });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/races/:id/protected-verification/final-challenge", requireAuth, async (req, res) => {
  const parsed = z.object({ verificationSessionId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid final-evidence challenge request." });
  const auth = req as AuthenticatedRequest;
  try {
    return res.status(201).json(await createFinalEvidenceChallenge({
      raceId: String(req.params.id), userId: auth.descopeUserId,
      verificationSessionId: parsed.data.verificationSessionId,
      authSessionId: auth.sessionId,
      registeredDeviceId: auth.deviceInfo?.deviceId,
    }));
  } catch (error) {
    return sendError(res, error);
  }
});

const finalEvidenceSchema = z.object({
  verificationSessionId: z.string().uuid(), challengeId: z.string().uuid(), serverChallenge: z.string().min(32).max(128),
  registeredDeviceId: z.string().min(1).max(256), serverStartAt: z.string().datetime(), serverEndAt: z.string().datetime(),
  approvedSource: z.enum(["health_connect", "healthkit"]), qualifyingSteps: z.number().int().min(0).max(500000),
  provisionalSteps: z.number().int().min(0).max(500000), verificationReadAt: z.string().datetime(),
  evidenceHash: z.string().min(32).max(128), integrity: integritySchema,
  sourceEvidence: z.object({
    automaticRecordCount: z.number().int().min(0).max(100000), manualEntryCount: z.number().int().min(0).max(100000),
    sourceIds: z.array(z.string().min(1).max(200)).max(100),
    recordingMethods: z.array(z.string().min(1).max(100)).max(20),
  }),
});

router.post("/races/:id/protected-verification/final-evidence", requireAuth, async (req, res) => {
  const parsed = finalEvidenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid final qualifying evidence.", details: parsed.error.issues });
  const auth = req as AuthenticatedRequest;
  if (parsed.data.registeredDeviceId !== auth.deviceInfo?.deviceId) {
    return res.status(409).json({ error: "Registered device changed.", code: "PROTECTED_SESSION_BINDING_MISMATCH" });
  }
  try {
    const result = await submitFinalProtectedEvidence({
      ...parsed.data, raceId: String(req.params.id), userId: auth.descopeUserId,
      requestHash: parsed.data.integrity.requestHash,
      integrityProvider: parsed.data.integrity.provider,
      integrityToken: parsed.data.integrity.token,
      authSessionId: auth.sessionId,
    });
    if (result.adjudication.ready) {
      const { autoCompleteRace } = await import("./races.js");
      await autoCompleteRace(String(req.params.id), "protected_evidence_finalized");
    }
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/races/:id/protected-verification/status", requireAuth, async (req, res) => {
  const auth = req as AuthenticatedRequest;
  const detail = await getProtectedRaceReview(String(req.params.id));
  if (!detail.room) return res.status(404).json({ error: "Race not found." });
  const session = detail.sessions.find((s) => s.userId === auth.descopeUserId);
  if (!session) return res.status(403).json({ error: "You are not a protected participant in this race." });
  const participant = detail.participants.find((row) => row.userId === auth.descopeUserId);
  const evidence = detail.evidence.find((e) => e.userId === auth.descopeUserId);
  return res.json({
    raceStatus: detail.room.status,
    adjudicationStatus: detail.room.adjudicationStatus,
    settlementStatus: detail.room.settlementStatus,
    serverStartAt: detail.room.startedAt,
    serverEndAt: detail.room.serverEndAt,
    verificationSessionId: session?.id ?? null,
    integrityStatus: session?.integrityStatus ?? null,
    continuityStatus: session?.continuityStatus ?? null,
    reviewReasons: [...new Set([...(session?.reviewReasons ?? []), ...(detail.room.adjudicationReasonCodes ?? [])])],
    evidenceSubmittedAt: evidence?.submittedAt ?? null,
    qualifyingSteps: detail.room.adjudicationStatus === "finalized"
      ? participant?.reconciledSteps ?? evidence?.qualifyingSteps ?? null
      : null,
    provisionalSteps: session ? evidence?.provisionalSteps ?? null : null,
  });
});

export default router;
