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
