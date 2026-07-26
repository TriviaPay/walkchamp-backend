# Strict Verification for Participant-Funded Races

Real-money races must **never** finalize a winner or issue a payout from provisional live sensor
progress. Live progress is intentionally provisional; paying from it would reward sensor inflation,
stale sessions, offline-replay errors, or incomplete health synchronization. This document
describes the strict-verification workflow that enforces that guarantee.

## Scope — which races are strict

Strict applies to **participant-funded (real-money) races**: `room.entryAmountCents > 0`, gated by
`ENABLE_HYBRID_STRICT_VERIFICATION` (and `ENABLE_HYBRID_RECONCILIATION`).

| Race type | Missing verification at deadline |
|-----------|----------------------------------|
| Real-money / USD cash (`entryAmountCents > 0`) | **Hold** → review (strict) |
| Paid prize-pool | **Hold** → review (strict) |
| Coins-only (`coins_battle`) | Configurable fallback (non-strict) — settles on capped live after timeout |
| Sponsored non-cash | Configurable fallback (non-strict) |
| Free | No financial payout |

If participants pay money into any prize-pool category, it is treated as strict even if the prize
is represented differently.

## The bounded workflow (never a permanent instant loss)

```
race ends
   ↓
verification_pending          (participant has no verified/reconciled total yet)
   ↓  grace period (HYBRID_VERIFICATION_GRACE_HOURS, default 4h; 2–6h)
   ├─ verification arrives → reconcile → finalized → winner/payout on RECONCILED steps
   └─ still missing → review_required   (HELD — completion deferred, never paid on live)
          ↓  ops SLA (HYBRID_REVIEW_WINDOW_HOURS, default 48h; 24–72h)
          └─ POST /races/:id/verification-resolve  (admin-key)
                 approve → set authoritative reconciled total → finalize
                 reject  → disqualify (excluded from winner selection)
                 resync  → back to pending, client re-submits verification
```

- During grace and review, `autoCompleteRace` **defers** (returns) — the race is not marked
  completed and no payout runs. The scheduler retries; verification arriving mid-window resolves it.
- A strict race settles **only** when every non-excluded participant is `finalized` (from verified/
  reconciled steps or an ops decision). Then the existing `selectWinners` / `creditCashChallengePrizes`
  run unchanged, fed the reconciled total.
- Only the backend issues the final decision. The review window is an operational SLA — an unresolved
  funded race stays **held**, it is never auto-paid from live.

## Server-controlled policy (never client-chosen)

`ABSENT_VERIFICATION_POLICY` selects the behavior when verification is missing at the deadline:

| Value | Behavior |
|-------|----------|
| `strict_hold` | Funded races (`entryAmountCents > 0`) hold → review; never pay on live |
| `strict_cash_only` | Same gate (real-money entry) — held; coins/sponsored use fallback |
| `pragmatic_fallback` | Settle on the capped live total after timeout (non-strict everywhere) |

Resolved in `config.hybridReconciliation.absentVerificationPolicy`; if unset it is derived from
`HYBRID_REQUIRE_VERIFICATION_FOR_PAYOUT` / `ENABLE_HYBRID_STRICT_VERIFICATION` for back-compat.

## Selective payout (race-level behavior)

An out-of-money unresolved participant does **not** block the winners. Before settling, the backend
checks whether any held participant could reach a paid slot:

- A held participant is **contested** if they are provisionally winning, finished the goal, are
  within `HYBRID_RECON_ABS_TOLERANCE` of the lowest paid winner's steps, or there is no resolved
  winner yet. Any contested held participant → **hold the whole settlement** (`review_required`).
- If every held participant is **provably out of the money** → finalize now, pay the verified
  winners, and record held participants as `review_required` with no payout (`partially_verified`).

Soundness: an ops approval is capped at `serverCap = live + tolerance`, so a held participant's
final total can never exceed that ceiling — an already-paid winner can never be retroactively
displaced. Equal-share Unlimited Challenges (separate module) hold the entire payout on any
unresolved participant, since one share change affects everyone.

## Statuses exposed to the app

- Race-level `race_rooms.settlement_status`: `awaiting_verification | partially_verified |
  review_required | paid`.
- `GET /races/:id/result-status` returns the authoritative per-user view — `verificationStatus`
  (`live | verification_pending | review_required | verification_rejected | finalized`), provisional
  `liveSteps`, and `steps/rank/payoutCents` **only when finalized**. The client must never label
  provisional steps as final.

## Audit

Every decision writes a durable `verification_decision_audit` row: both source step values, the
`decision` (`verified | held | approved_manually | rejected | excluded`), `reasonCode`, and
`decidedBy` (`system | operations`).

## Configuration (all backend-authoritative)

| Env | Default | Meaning |
|-----|---------|---------|
| `ENABLE_HYBRID_RECONCILIATION` | off | Master switch for the hybrid pipeline |
| `ABSENT_VERIFICATION_POLICY` | derived | `strict_hold` / `strict_cash_only` / `pragmatic_fallback` |
| `ENABLE_HYBRID_STRICT_VERIFICATION` | off | Legacy switch → derives `strict_hold` when true |
| `HYBRID_VERIFICATION_GRACE_HOURS` | 4 | Health-sync grace before a miss becomes reviewable (2–6h) |
| `HYBRID_REVIEW_WINDOW_HOURS` | 48 | Ops SLA window, informational (24–72h) |
| `HYBRID_RECON_ABS_TOLERANCE` | 100 | Absolute step tolerance band |

## Endpoints

- `POST /races/:id/verify` — participant submits a verified Health Connect / HealthKit race total
  (stored separately from live; monotonic; stale-guarded). Flag-gated (404 when off).
- `GET /races/:id/result-status` — authoritative per-user result status; final fields populated only
  when finalized.
- `POST /races/:id/verification-resolve` — **ops only** (admin key): `{ userId, decision:
  approve|reject|resync, steps?, note? }`. Approval capped at `serverCap`. Idempotent (a finalized
  participant is not re-decided); re-attempts completion after the decision.

## Rollout

Ship `ENABLE_HYBRID_STRICT_VERIFICATION` **off**. Turn it on once mobile clients reliably send
`POST /races/:id/verify` for funded races — otherwise those races will legitimately hold for review
(which is the safe behavior, but requires an ops process to be staffed).
