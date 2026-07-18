# gians — API Reference

Base URL: `http://<host>:<port>/api`

- All request and response bodies are JSON.
- Authenticated endpoints require `Authorization: Bearer <accessToken>`.
- Errors share one envelope:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Validation failed",
    "details": [{ "field": "username", "message": "Username must be 3-30 characters" }]
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed or failed validation |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | No such resource |
| `CONFLICT` | 409 | Unique constraint violated |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL` | 500 | Unexpected server error |

### Rate limits

| Scope | Window | Limit |
|---|---|---|
| `/auth/*` | 15 min | 20 failed requests per IP |
| `/users/search` | 1 min | 60 per IP |
| everything else under `/api` | 1 min | 240 per IP |

---

## Health

### `GET /api/health`

Unauthenticated. Returns `503` when the database is not connected.

```json
{
  "status": "ok",
  "database": "connected",
  "uptimeSeconds": 3412,
  "timestamp": "2026-07-18T17:23:21.041Z"
}
```

---

## Authentication

### `POST /api/auth/register`

| Field | Type | Required | Rules |
|---|---|---|---|
| `username` | string | yes | 3–30, `^[a-z0-9_.]+$`, lowercased |
| `password` | string | yes | 8–128 |
| `displayName` | string | no | ≤60, defaults to username |
| `phone` | string | no | E.164, `^\+[1-9]\d{7,14}$` |

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123","displayName":"Alice Kapoor","phone":"+919812345001"}'
```

**`201 Created`**

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "eyJhbGciOi...",
  "user": {
    "id": "66a1f2c3d4e5f60718293a4b",
    "username": "alice",
    "displayName": "Alice Kapoor",
    "phone": "+919812345001",
    "avatarColor": "#5B8DEF",
    "about": "Available",
    "isOnline": false,
    "lastSeen": "2026-07-18T17:20:00.000Z"
  }
}
```

`409` if the username or phone is taken (`details[0].field` says which).

---

### `POST /api/auth/login`

```json
{ "identifier": "alice", "password": "password123" }
```

`identifier` is a username, or a phone number when it starts with `+`.
Returns the same session envelope as register. Always `401` with an identical
message for both a wrong password and an unknown account.

---

### `POST /api/auth/refresh`

```json
{ "refreshToken": "eyJhbGciOi..." }
```

Returns a **new** access and refresh token; the presented one is revoked.
Presenting an already-revoked token revokes every session for that user and
returns `401` — this is the reuse-detection path.

---

### `POST /api/auth/logout`

Body `{ "refreshToken": "..." }`. Revokes that one session. `204`.

### `POST /api/auth/logout-all` 🔒

Revokes every session for the current user. `204`.

### `GET /api/auth/me` 🔒

```json
{
  "user": {
    "id": "66a1...", "username": "alice", "displayName": "Alice Kapoor",
    "phone": "+919812345001", "avatarColor": "#5B8DEF", "about": "Available",
    "isOnline": true, "lastSeen": "2026-07-18T17:22:00.000Z",
    "settings": {
      "ringtoneEnabled": true, "vibrationEnabled": true,
      "echoCancellation": true, "noiseSuppression": true, "autoGainControl": true
    },
    "contactCount": 3
  }
}
```

---

## Users

All endpoints below require authentication.

### `GET /api/users/search?q=<term>&limit=<n>`

`q` must be at least 2 characters. Matches username prefix, display-name
substring, or phone suffix. Excludes the caller. `limit` caps at 50.
Regex metacharacters in `q` are escaped.

```json
{
  "users": [
    { "id": "66a2...", "username": "bob", "displayName": "Bob Mehta",
      "phone": "+919812345002", "avatarColor": "#4CAF7D", "about": "Available",
      "isOnline": true, "isBusy": false, "lastSeen": "2026-07-18T17:22:00.000Z" }
  ]
}
```

### `GET /api/users/presence?ids=<id1,id2,...>`

Bulk presence lookup, max 200 ids.

```json
{ "presence": [ { "userId": "66a2...", "isOnline": true, "isBusy": false } ] }
```

### `GET /api/users/contacts`

Returns the caller's contacts, online first, then alphabetical.

```json
{ "contacts": [ { "id": "66a2...", "username": "bob", "isOnline": true, "isBusy": false } ] }
```

### `POST /api/users/contacts`

Body `{ "userId": "<mongo id>" }`. Idempotent. `201` with the added contact.
`400` when adding yourself, `404` when the user does not exist.

### `DELETE /api/users/contacts/:userId`

`204`.

### `PATCH /api/users/me`

```json
{
  "displayName": "Alice K.",
  "about": "In a meeting",
  "settings": { "noiseSuppression": false }
}
```

All fields optional; `settings` merges key by key rather than replacing the
object. Returns the updated user with settings.

### `GET /api/users/:userId`

Public profile of one user.

---

## Calls

All endpoints require authentication.

### `GET /api/calls/ice-servers`

```json
{
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] },
    { "urls": ["turn:turn.example.com:3478"],
      "username": "1752861600:66a1...", "credential": "base64hmac==" }
  ]
}
```

When `TURN_STATIC_SECRET` is set, credentials are ephemeral HMAC pairs
(coturn REST mode) valid for `TURN_CREDENTIAL_TTL` seconds.

### `GET /api/calls/history?limit=<n>&cursor=<iso>&missed=true`

Cursor-paginated, newest first. `limit` caps at 100.

```json
{
  "items": [
    {
      "callId": "6f1c2e34-...",
      "peer": { "id": "66a2...", "username": "bob", "displayName": "Bob Mehta",
                "avatarColor": "#4CAF7D", "isOnline": true },
      "direction": "outgoing",
      "status": "ended",
      "missed": false,
      "startedAt": "2026-07-18T17:20:00.000Z",
      "answeredAt": "2026-07-18T17:20:04.000Z",
      "endedAt": "2026-07-18T17:23:10.000Z",
      "duration": 186,
      "endReason": "hangup"
    }
  ],
  "nextCursor": "2026-07-18T17:20:00.000Z"
}
```

`nextCursor` is `null` on the last page. `missed=true` returns only calls the
caller failed to answer.

> `direction` and `missed` are relative to the requesting user. The same call
> is `outgoing`/`cancelled`/`missed: false` for the caller and
> `incoming`/`cancelled`/`missed: true` for the callee.

### `GET /api/calls/recents?limit=<n>`

The most recent call per distinct peer, newest first.

```json
{
  "recents": [
    {
      "callId": "6f1c2e34-...", "direction": "outgoing", "status": "ended",
      "missed": false, "duration": 186, "startedAt": "2026-07-18T17:20:00.000Z",
      "peer": { "id": "66a2...", "username": "bob", "displayName": "Bob Mehta",
                "avatarColor": "#4CAF7D", "isOnline": true, "isBusy": false },
      "totalCalls": 12,
      "missedCount": 2
    }
  ]
}
```

### `GET /api/calls/stats`

```json
{
  "stats": {
    "totalCalls": 42, "answeredCalls": 31, "missedCalls": 5,
    "totalSeconds": 7420, "averageSeconds": 239
  }
}
```

### `GET /api/calls/:callId`

Single call. `403` if the requester was not a participant.

---

## Push (ringing closed devices)

### `GET /api/push/vapid-public-key`

Unauthenticated — the browser needs this before it can subscribe.

```json
{ "publicKey": "<your VAPID public key>", "enabled": true }
```

`enabled` is `false` when the server has no VAPID keys configured, in which
case calls only ring while the app is open.

### `POST /api/push/subscribe` 🔒

Registers one device. Send the object returned by `PushSubscription.toJSON()`.

```json
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": { "p256dh": "BLc4xRz...", "auth": "aUmpAgt7..." }
  }
}
```

**`201 Created`** → `{ "ok": true, "devices": 2 }`

Idempotent: the endpoint is the unique key, so re-subscribing the same browser
updates the row rather than adding another. If that device now belongs to a
different signed-in user, ownership transfers with it.

`400` if the subscription is malformed.

### `DELETE /api/push/subscribe` 🔒

Body `{ "endpoint": "https://..." }`. Stops that device ringing. `204`.

### `POST /api/push/call-action`

**Unauthenticated by design.** Called by the service worker when the user taps
**Decline** on a locked device, where no access token is available.

```json
{ "actionToken": "eyJhbGciOi...", "action": "reject" }
```

`actionToken` is a short-lived (120 s) JWT delivered inside the push payload,
scoped to one user and one `callId`. It cannot be used for anything else, and
an ordinary access token is rejected here.

**`200 OK`** → `{ "ok": true, "status": "rejected" }`

Returns `{ "ok": true, "status": "already-resolved" }` when the call ended
while the notification was still on screen — a common race, not an error.

Only `"reject"` is accepted. Answering requires the full WebRTC stack, so it
must happen in the page.

Errors: `401` (invalid/expired token, or wrong token type), `400` (unsupported
action).

---

## Push payloads (server → service worker)

The service worker receives these as the JSON body of a `push` event.

### `incoming-call`
```json
{
  "type": "incoming-call",
  "callId": "6f1c2e34-...",
  "from": { "id": "66a1...", "username": "alice", "displayName": "Alice Kapoor" },
  "actionToken": "eyJhbGciOi...",
  "expiresAt": 1752861645000
}
```
Sent with `urgency: high` and `TTL: 45`, so a late delivery is dropped rather
than ringing about a call that already ended. The worker ignores it outright if
`expiresAt` has passed, or if a visible window is already handling the call.

### `call-cancelled`
```json
{ "type": "call-cancelled", "callId": "6f1c...", "reason": "answered" }
```
Dismisses the ringing notification. `reason` is `answered`, `declined`,
`no-answer`, `hangup` or another end reason. Sent when the call is answered
(including on another device), declined, cancelled by the caller, or times out.

### `missed-call`
```json
{ "type": "missed-call", "callId": "6f1c...", "from": { ... } }
```
Sent with `TTL: 3600` and normal urgency — this one is worth delivering late.

---

# Socket.IO events

Connect with the access token in the handshake:

```js
const socket = io({ auth: { token: accessToken } });
```

A failed handshake emits `connect_error` with `err.data.code` of
`NO_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` or `NO_ACCOUNT`.

Every client-emitted event accepts an acknowledgement callback:

```js
socket.emit('call:initiate', { calleeId }, (res) => {
  if (!res.ok) console.error(res.error.code, res.error.message);
});
```

Acks are `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`.

Each connection automatically joins two rooms: `user:<id>` (all of that user's
devices) and `presence:<id>`.

---

## Server → client

### `ready`
Sent immediately after a successful handshake.
```json
{ "user": { "id": "...", "username": "alice", "displayName": "Alice Kapoor",
            "avatarColor": "#5B8DEF" },
  "serverTime": 1752861600000, "ringTimeoutMs": 45000 }
```

### `presence:update`
Pushed to subscribers of `presence:<userId>`.
```json
{ "userId": "66a2...", "isOnline": true, "lastSeen": "2026-07-18T17:22:00.000Z" }
```

### `call:incoming`
```json
{ "callId": "6f1c...", "from": { "id": "66a1...", "username": "alice",
  "displayName": "Alice Kapoor", "avatarColor": "#5B8DEF" },
  "startedAt": "2026-07-18T17:20:00.000Z", "iceServers": [ ... ] }
```

### `call:accepted`
`{ "callId": "...", "answeredAt": "..." }` — to the caller.

### `call:rejected`
`{ "callId": "...", "reason": "declined" }` — to the caller.
`reason` is `declined`, `busy` or `media-error`.

### `call:ended`
```json
{ "callId": "...", "status": "ended", "duration": 186,
  "reason": "hangup", "endedBy": "66a1..." }
```
`reason` may also be `no-answer`, `peer-disconnected`, `page-closed`,
`connection-failed` or `negotiation-failed`.

### `call:missed`
`{ "callId": "...", "from": { ... } }` — to the callee only.

### `call:handled-elsewhere`
`{ "callId": "..." }` — tells this user's *other* devices to stop ringing.

### `call:resumed`
Sent on connect when a call survived a disconnect.
`{ "call": { ...history row shape... } }`

### `call:peer-media-state`
`{ "callId": "...", "muted": true, "speaker": false }`

### `call:peer-quality`
`{ "callId": "...", "rating": "good" }`

### `webrtc:offer` / `webrtc:answer` / `webrtc:ice-candidate` / `webrtc:restart`
Relayed verbatim, with `from: "<senderUserId>"` added. The server never parses
SDP.

---

## Client → server

### `call:initiate`
`{ "calleeId": "<userId>" }`

Ack on success:
```json
{ "ok": true, "callId": "6f1c...", "status": "ringing", "iceServers": [ ... ] }
```

Ack when the call cannot proceed — note this is still `ok: true`, with
`blocked` explaining why:
```json
{ "ok": true, "callId": "6f1c...", "status": "busy", "blocked": "busy" }
```
`blocked` is `busy` (callee already on a call) or `unavailable` (callee
offline). The attempt is still written to call history.

Errors: `BAD_REQUEST` (calling yourself, or you are already on a call),
`NOT_FOUND` (no such user).

### `call:accept`
`{ "callId": "..." }` → `{ ok, callId, answeredAt, iceServers }`.
`FORBIDDEN` unless you are the callee; `BAD_REQUEST` if it is no longer ringing.

### `call:reject`
`{ "callId": "...", "reason": "declined" }` → `{ ok, callId, status }`.

### `call:end`
`{ "callId": "...", "reason": "hangup" }` → `{ ok, callId, status, duration, reason }`.

Resulting status depends on timing:

| When | Status |
|---|---|
| after answer | `ended` (with duration) |
| before answer, by caller | `cancelled` |
| before answer, by callee | `missed` |
| ring timeout expires | `missed` |

### `webrtc:offer` / `webrtc:answer` / `webrtc:ice-candidate` / `webrtc:restart`

```json
{ "callId": "...", "sdp": { "type": "offer", "sdp": "v=0\r\n..." } }
{ "callId": "...", "candidate": { "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0 } }
```

The server verifies you are a participant and the call is not terminal, then
forwards to the peer. Errors: `FORBIDDEN`, `NOT_FOUND`, `CALL_ENDED`.

### `call:media-state`
`{ "callId": "...", "muted": true, "speaker": false }`

### `call:quality`
```json
{ "callId": "...",
  "sample": { "rating": "good", "rttMs": 42, "jitterMs": 8,
              "packetLossPct": 0.3, "connectionType": "srflx" } }
```
Persisted on the call record and the rating is forwarded to the peer.

### `presence:subscribe` / `presence:unsubscribe`
`{ "userIds": ["66a2...", "66a3..."] }` — max 500 per call.
Subscribe acks with a snapshot:
```json
{ "ok": true, "presence": [ { "userId": "66a2...", "isOnline": true, "isBusy": false } ] }
```

### `call:resync`
No payload. Returns the caller's live call, or `null`.
```json
{ "ok": true, "call": { ... }, "iceServers": [ ... ] }
```

---

## Reconnection behaviour

- The client reconnects with exponential backoff (0.8s → 8s, jitter 0.5),
  refreshing the access token before each attempt.
- When the last socket for a user closes **during a call**, the server waits
  **20 seconds** before ending it. Reconnecting within that window keeps the
  call alive; WebRTC media frequently survives the signalling drop.
- After that window the call ends with `reason: "peer-disconnected"`.
- On the media side, an `iceConnectionState` of `failed` triggers an automatic
  ICE restart, up to 3 attempts, before the call is abandoned.
