# Streak Challenge backend contract

Streak Challenge is the public name for the multi-day, daily-goal pooled challenge previously
called Unlimited Challenge. New clients and operator tooling must use the canonical names below.

## Canonical endpoints

All endpoints are under `/api` and require authentication unless an admin role is stated.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/streak-challenges/host` | Host and auto-join a challenge |
| `POST` | `/streak-challenges/:id/join` | Join before the viewer's locked local start |
| `POST` | `/streak-challenges/:id/timezone` | Confirm a participant timezone change |
| `POST` | `/streak-challenges/:id/leave` | Leave under the existing refund/forfeit policy |
| `GET` | `/streak-challenges` | Paginated public list; supports `status=active` |
| `GET` | `/streak-challenges/live` | Public live browse list |
| `GET` | `/streak-challenges/recently-finished` | Recently finished list |
| `GET` | `/streak-challenges/my-active` | Viewer membership-scoped active challenge |
| `GET` | `/streak-challenges/:id` | Detail, roster, viewer schedule, and final flow |
| `POST` | `/streak-challenges/:id/live-progress` | Provisional live sensor progress |
| `GET` | `/streak-challenges/:id/daily-history` | Locked-window daily history |
| `POST` | `/streak-challenges/:id/final-verification` | Submit the final provider read |
| `GET/POST` | `/streak-challenges/:id/comments` | Live chat history and posting |
| `GET/POST` | `/streak-challenges/:id/reactions` | Live reaction counts and posting |
| `GET` | `/streak-challenges/:id/leaderboard` | Paginated informational leaderboard |

Admin-only endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/streak-challenges/:challengeId/days/:dayId/verification-resolve` | Resolve a funded day verification |
| `POST` | `/admin/streak-challenges/cancel-all` | Cancel/refund all open challenges |
| `POST` | `/admin/streak-challenges/:id/cancel` | Cancel/refund one challenge |

The provisional endpoint returned inside the viewer payload is always canonical:

```json
{
  "provisionalStepsEndpoint": "/api/streak-challenges/<challenge-id>/live-progress"
}
```

## Environment variables

| Canonical variable | Default | Legacy fallback |
| --- | --- | --- |
| `FEATURE_STREAK_CHALLENGE` | `true` | `FEATURE_UNLIMITED_GOAL` |
| `STREAK_CHALLENGE_GRACE_HOURS` | `4` | `UNLIMITED_GOAL_GRACE_HOURS` |
| `STREAK_CHALLENGE_VERIFICATION_MODE` | `manual` in production | `UNLIMITED_VERIFICATION_MODE` |
| `STREAK_CHALLENGE_ZERO_WINNER_POLICY` | `manual_review` | `UNLIMITED_GOAL_ZERO_WINNER_POLICY` |

When both canonical and legacy variables exist, the canonical value wins. Set the canonical values
in Coolify before removing legacy values.

## Compatibility contract

- Former `/api/unlimited-challenges/*` and `/api/admin/unlimited-challenges/*` URLs remain working
  aliases and return `Deprecation: true` plus a successor link.
- Existing Postgres table names, audit identifiers, idempotency keys, and the `unlimited_goal`
  machine discriminator are intentionally unchanged. Renaming them would require a risky data and
  multi-client migration with no user-visible benefit.
- API challenge objects add `challengeKind: "streak_challenge"` and
  `apiBasePath: "/api/streak-challenges"`. `challengeType` and `entryType` remain
  `"unlimited_goal"` during the compatibility window.
- No database migration is required for this naming change.

## Final-result flow

Clients should render the backend-owned `viewer.finalResult` contract and must not calculate day
boundaries or settlement states from device time. `viewer.finalFlow` remains as a deprecated
lowercase compatibility contract.

| Situation | `finalResultStatus` (participant) | `raceFinalStatus` |
|---|---|---|
| This viewer's final local day ended; another valid participant is still inside theirs | `FINAL_DAY_COMPLETED_WAITING` | `WAITING_FOR_PARTICIPANT_DAY_ENDS` |
| The last valid participant's final local day ended | `FINAL_VERIFICATION` | `FINAL_VERIFICATION` |
| At least two hours elapsed and a provider submission/completion shows verification is progressing | `RESULTS_READY` | `PREPARING_LEADERBOARD` |
| Payout/result settlement committed, publication still pending | `RESULTS_READY` | `SETTLED` |
| Result events were published | `RESULTS_ANNOUNCED` | `RESULTS_ANNOUNCED` |

Example participant contract:

```json
{
  "viewer": {
    "finalResultStatus": "RESULTS_READY",
    "raceFinalStatus": "PREPARING_LEADERBOARD",
    "finalResult": {
      "participantStatus": "RESULTS_READY",
      "raceStatus": "PREPARING_LEADERBOARD",
      "title": "Results Ready",
      "message": "Final verification is almost complete. We’re preparing the leaderboard.",
      "lastParticipantEndAtUtc": "2026-09-01T15:00:00.000Z",
      "verificationStartedAt": "2026-09-01T15:00:00.000Z",
      "preparingLeaderboardAt": "2026-09-01T17:00:00.000Z",
      "settlementEligibleAt": "2026-09-01T19:00:00.000Z",
      "verificationElapsedSeconds": 7200,
      "preparingLeaderboardAfterSeconds": 7200,
      "verificationWindowSeconds": 14400,
      "verificationProgressing": true,
      "verificationPending": true
    }
  }
}
```

Status payload examples (timing/counter fields are present in every non-null `finalResult`):

```json
[
  {
    "finalResultStatus": "FINAL_DAY_COMPLETED_WAITING",
    "raceFinalStatus": "WAITING_FOR_PARTICIPANT_DAY_ENDS",
    "finalResult": {
      "participantStatus": "FINAL_DAY_COMPLETED_WAITING",
      "raceStatus": "WAITING_FOR_PARTICIPANT_DAY_ENDS",
      "title": "Final Day Completed",
      "message": "Your final challenge day is complete. We’re waiting for the remaining participants to finish in their local time zones."
    }
  },
  {
    "finalResultStatus": "FINAL_VERIFICATION",
    "raceFinalStatus": "FINAL_VERIFICATION",
    "finalResult": {
      "participantStatus": "FINAL_VERIFICATION",
      "raceStatus": "FINAL_VERIFICATION",
      "title": "Final Verification",
      "message": "Your challenge is complete. We’re verifying the final activity for all participants."
    }
  },
  {
    "finalResultStatus": "RESULTS_READY",
    "raceFinalStatus": "PREPARING_LEADERBOARD",
    "finalResult": {
      "participantStatus": "RESULTS_READY",
      "raceStatus": "PREPARING_LEADERBOARD",
      "title": "Results Ready",
      "message": "Final verification is almost complete. We’re preparing the leaderboard."
    }
  },
  {
    "finalResultStatus": "RESULTS_READY",
    "raceFinalStatus": "SETTLED",
    "finalResult": {
      "participantStatus": "RESULTS_READY",
      "raceStatus": "SETTLED",
      "title": "Results Ready",
      "message": "Final verification is almost complete. We’re preparing the leaderboard."
    }
  },
  {
    "finalResultStatus": "RESULTS_ANNOUNCED",
    "raceFinalStatus": "RESULTS_ANNOUNCED",
    "finalResult": {
      "participantStatus": "RESULTS_ANNOUNCED",
      "raceStatus": "RESULTS_ANNOUNCED",
      "title": "Streak Challenge Completed",
      "message": "Streak Challenge Completed. The final results are ready. Congratulations to all participants!"
    }
  }
]
```

The verification clock starts at the maximum persisted `participantEndAtUtc` among valid frozen
settlement participants. `STREAK_CHALLENGE_GRACE_HOURS=4` is the earliest settlement boundary, not
a force-settlement timeout: pending Health Connect/HealthKit final verification or non-terminal day
rows keep the challenge in verification after four hours. The two-hour preparation state is a
presentation signal and never writes `resultsStatus=results_ready`; only atomic settlement does.

Before this flow begins, `finalResultStatus`, `raceFinalStatus`, and `finalResult` are `null`.
