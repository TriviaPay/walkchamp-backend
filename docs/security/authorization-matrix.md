# Authorization Matrix

This matrix documents the minimum object-level authorization rules enforced by the backend.

| Route | Object | Required relationship / role |
| --- | --- | --- |
| `/api/auth/profile/:userId` | `userId` | caller must be the same user |
| `/api/chat/private/:friendId` | `conversation/friendId` | caller must be conversation participant / friend |
| `/api/chat/messages/:messageId/report` | `messageId` | authenticated active user; one report per user/message |
| `/api/realtime/pusher/auth` | `channel_name` | caller must belong to referenced user/chat/race scope |
| `/api/presence/friends/online` | `friend graph` | caller sees accepted friends only |
| `/api/presence/groups/:groupId/online` | `groupId` | caller must be active group member |
| `/api/presence/races/:raceId/online` | `raceId` | caller must be participant or spectator |
| `/api/races/:id/progress` | `raceId` | caller must be current participant |
| `/api/races/:id/join-paid` | `raceId` | cash disabled in v1 |
| `/api/wallet/*` | `walletId` | cash disabled in v1 |
| `/api/wallet/deposit/*` | `transactionId` | cash disabled in v1 |
| `/api/payments/*` | `paymentId` | cash disabled in v1 |
| `/api/admin/*` | target object | caller must be authenticated admin user |
| `/api/push/send` | push broadcast payload | service credential only |
| `/api/races/:id/force-complete` | `raceId` | authenticated user plus service credential |

Rules:
- Authentication is never sufficient by itself for object-bearing routes.
- Cash routes are blocked for v1 even with a valid JWT.
- Private presence, chat, and race channels always require membership checks.

---

## 2026-08-17 update — cash features are live

The "cash disabled in v1" rows above are superseded (audit 2026-08-16 F-08). Cash is live on
Stripe (USD) and Razorpay (INR). Cash routers are no longer blocked; instead they are gated by
`requireCashFeaturesEnabled` (mounted at the top of each router) plus the `REAL_MONEY_*` startup
gate in `src/lib/config.ts`, which forces all five approval flags `true` when cash + live mode
are both on and refuses to boot otherwise.

| Route | Object | Required relationship / role | Gate |
| --- | --- | --- | --- |
| `/api/wallet/*` | own wallet | caller's `userId` only; wallet looked up by session user | `requireCashFeaturesEnabled` + `requireAuth` |
| `/api/wallet/withdraw` | own wallet balance | caller's wallet, row-locked; admin approves separately | `requireCashFeaturesEnabled` + `requireAuth` |
| `/api/wallet/deposit/*` (Stripe/Razorpay) | own deposit transaction | caller creates/reads own deposits; webhooks are signature-verified | `requireCashFeaturesEnabled` + `requireAuth` |
| `/api/payments/*` | own payment | caller must own the payment row | `requireCashFeaturesEnabled` + `requireAuth` |
| `/api/races/:id/join-paid` | `raceId` | active participant slot + completed entry payment (per-user idempotency key) | cash gate + `requireAuth` |
| `/api/races` coins-battle entry | `raceId` | coin balance debited under row lock; non-payers disqualified, never admitted free | `requireAuth` |
| `/api/referral` / `/api/referral/apply` | own profile | caller sets own `referredBy`; self-referral excluded | `requireAuth` |
| referral bonus (service-side) | referrer + referred wallets | fires only on referred user's first completed cash entry; unique award per referred user; per-referrer rolling-24h velocity cap | internal (race join transaction) |
| `/api/unlimited-challenge/*` | own membership | caller must be the registered member; steps server-reconciled | `requireAuth` + `FEATURE_UNLIMITED_GOAL` |
| waiting-room lifecycle (`/api/races` rooms) | `raceRoomId` | host-only start/cancel; refunds deduped per `race_cancel:{raceId}:{uid}` in a locked transaction | `requireAuth` |
| `/api/sponsored-events/*` | `eventId` | registration requires own account; winner finalization is admin/service-side | `requireAuth` |
| `/api/admin/withdrawals/*` | `withdrawalId` | admin role; approval is atomic CAS on `status='pending'` | `requireAuth` + `requireAdminRole` (file-wide) |
| `DELETE /api/me/account` | own profile | caller only; refused (409) with positive balance, open withdrawal, or in-flight paid race; PII anonymized and sessions revoked on success | `requireAuth` |

Updated rules:
- Cash routes require `requireCashFeaturesEnabled` **and** per-object ownership — the feature
  gate is never a substitute for the ownership check.
- Every wallet balance mutation happens under a `SELECT ... FOR UPDATE` row lock with a unique
  idempotency key on the ledger row.
- `CASH_FEATURES_ENABLED=false` in the Coolify env is the server-side kill switch for the whole
  cash surface (minutes to take effect: env change + restart).
