# gians — Deployment Guide

Covers HTTPS, TURN, reverse proxying, process management, containers, and what
to change before running more than one instance.

---

## 1. Why HTTPS is mandatory

`getUserMedia()` only works in a **secure context**. In practice:

- `http://localhost` — allowed (browsers make an exception)
- `http://192.168.1.50` — **blocked**, no microphone
- `https://calls.example.com` — allowed

So the moment you leave your own machine, you need TLS. There is no workaround
worth pursuing; browsers treat this as a hard requirement.

---

## 2. Production checklist

- [ ] `NODE_ENV=production`
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` set to real random values
- [ ] `CLIENT_ORIGIN` set to your exact HTTPS origin (never `*`)
- [ ] `MONGODB_URI` points at a database with authentication enabled
- [ ] TURN configured (`TURN_URLS` + credentials)
- [ ] VAPID keys set, if calls should ring closed/locked devices
- [ ] TLS terminating in front of the app
- [ ] Process manager restarting the app on failure
- [ ] Automated MongoDB backups

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The server refuses to start in production with missing or placeholder secrets.

---

## 3. TURN server (coturn)

Without TURN, calls fail whenever both peers are behind symmetric NAT — typical
on mobile data and many corporate networks. Budget for roughly 10–20% of calls
needing a relay, at about 40 kbps per relayed call.

### Install

```bash
sudo apt update && sudo apt install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn
```

### Configure `/etc/turnserver.conf`

```conf
listening-port=3478
tls-listening-port=5349

# Public IP of this machine. On a cloud VM behind NAT, also set:
#   external-ip=<public-ip>/<private-ip>
external-ip=203.0.113.10

realm=turn.example.com
server-name=turn.example.com

# Ephemeral credentials — this must match TURN_STATIC_SECRET in the app's .env
use-auth-secret
static-auth-secret=REPLACE_WITH_A_LONG_RANDOM_STRING

# TLS lets TURN traverse firewalls that only permit 443/TLS traffic
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Relay port range — open these in the firewall
min-port=49152
max-port=65535

fingerprint
no-multicast-peers
# Block relaying to internal networks (SSRF protection)
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
no-cli
```

```bash
sudo systemctl enable --now coturn
```

### Firewall

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

### App configuration

```env
TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
TURN_STATIC_SECRET=REPLACE_WITH_A_LONG_RANDOM_STRING
TURN_CREDENTIAL_TTL=86400
```

With `TURN_STATIC_SECRET` set, the app mints time-limited HMAC credentials per
user. Do not also set `TURN_USERNAME`/`TURN_CREDENTIAL` — the static secret
takes precedence.

### Verify

Use the [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
Paste a TURN URL with credentials from `GET /api/calls/ice-servers`. You must
see at least one candidate of type **relay**. If not, TURN is not working and
symmetric-NAT calls will fail silently.

---

## 3b. Web Push (ringing closed devices)

Without VAPID keys, calls only ring while the app is open in the foreground.

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

```env
VAPID_PUBLIC_KEY=BIYY...
VAPID_PRIVATE_KEY=uc4s...
VAPID_SUBJECT=mailto:you@example.com
```

Notes that matter in production:

- **Do not rotate the keys casually.** Every existing subscription is bound to
  the public key it was created with; changing it silently stops every
  registered device from ringing until each user re-enables it.
- **HTTPS is mandatory.** Service workers and push are unavailable on plain
  HTTP (except `localhost`).
- The server must reach the push endpoints outbound on **443**
  (`fcm.googleapis.com`, `updates.push.services.mozilla.com`,
  `*.notify.windows.com`, `web.push.apple.com`). Egress-filtered networks need
  these allowlisted.
- Dead subscriptions are pruned automatically when a push service returns
  404/410, so the collection does not accumulate stale devices.
- No Firebase project or Google account is required. VAPID is an open standard;
  FCM is only the transport Chrome happens to use.

**iOS caveat worth putting in your onboarding copy:** iOS delivers Web Push
only to a PWA installed via *Share → Add to Home Screen*, on iOS 16.4+. A plain
Safari tab will never ring. The app detects this and tells the user, but users
will still need telling.

---

## 4. Reverse proxy (nginx)

WebSockets need the upgrade headers, and long-lived connections need a generous
read timeout — this is the most common cause of calls dropping after ~60s.

```nginx
server {
    listen 80;
    server_name calls.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name calls.example.com;

    ssl_certificate     /etc/letsencrypt/live/calls.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/calls.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;

        # Required for the Socket.IO websocket upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Keep idle websockets alive; the default 60s kills calls mid-conversation
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering off;
    }
}
```

The app sets `trust proxy`, so `req.ip` and the rate limiter see the real
client address through these headers.

### TLS certificate

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d calls.example.com
```

---

## 5. Running the process

### systemd

`/etc/systemd/system/gians.service`:

```ini
[Unit]
Description=gians VoIP server
After=network.target

[Service]
Type=simple
User=gians
WorkingDirectory=/opt/gians
EnvironmentFile=/opt/gians/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/gians

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gians
sudo journalctl -u gians -f
```

The app handles `SIGTERM` gracefully: it stops accepting connections, closes
Socket.IO, disconnects Mongo, and hard-exits after 10 seconds if anything hangs.

### PM2

```bash
npm install -g pm2
pm2 start server/index.js --name gians
pm2 save && pm2 startup
```

> Do **not** use `pm2 -i max` (cluster mode) without first adding the Redis
> adapter — see [scaling](#8-scaling-beyond-one-process).

---

## 6. Docker

`Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 4000

USER node
CMD ["node", "server/index.js"]
```

`docker-compose.yml`:

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - "4000:4000"
    environment:
      NODE_ENV: production
      PORT: 4000
      MONGODB_URI: mongodb://mongo:27017/gians_voip
      CLIENT_ORIGIN: https://calls.example.com
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      STUN_URLS: stun:stun.l.google.com:19302
      TURN_URLS: ${TURN_URLS}
      TURN_STATIC_SECRET: ${TURN_STATIC_SECRET}
    depends_on:
      - mongo

  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

```bash
docker compose up -d --build
```

---

## 7. MongoDB

### Self-hosted

Enable authentication and bind to a private interface:

```javascript
use admin
db.createUser({
  user: "gians",
  pwd: "<strong-password>",
  roles: [{ role: "readWrite", db: "gians_voip" }]
})
```

```env
MONGODB_URI=mongodb://gians:<password>@127.0.0.1:27017/gians_voip?authSource=admin
```

Back up on a schedule:

```bash
mongodump --uri="$MONGODB_URI" --out=/backups/$(date +%F)
```

### MongoDB Atlas

1. Create a free M0 cluster.
2. **Database Access** → add a user with *Read and write to any database*.
3. **Network Access** → allowlist your server's IP (avoid `0.0.0.0/0`).
4. Copy the connection string:

```env
MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/gians_voip?retryWrites=true&w=majority
```

**If `mongodb+srv://` fails with `querySrv ECONNREFUSED`**, Node cannot reach a
DNS resolver for the SRV lookup. Use the equivalent direct seed list, which
skips SRV entirely:

```bash
# Read the shard hostnames and options from DNS:
dig +short SRV _mongodb._tcp.cluster0.xxxxx.mongodb.net
dig +short TXT cluster0.xxxxx.mongodb.net
```

```env
MONGODB_URI=mongodb://user:pass@shard-00-00.xxxxx.mongodb.net:27017,shard-00-01.xxxxx.mongodb.net:27017,shard-00-02.xxxxx.mongodb.net:27017/gians_voip?ssl=true&replicaSet=atlas-xxxxxx-shard-0&authSource=admin&retryWrites=true&w=majority
```

Indexes are created automatically by Mongoose on first connect.

---

## 8. Scaling beyond one process

The app is **single-process by design**. Presence and busy state live in memory
(`server/services/presenceService.js`). Two instances would each see only their
own connections, so users would appear offline to half the traffic and busy
checks would miss.

To run multiple instances you need three changes:

**1. Socket.IO Redis adapter** — so `io.to('user:<id>')` reaches sockets on
other instances:

```bash
npm install @socket.io/redis-adapter redis
```

```js
// server/socket/index.js
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const pub = createClient({ url: process.env.REDIS_URL });
const sub = pub.duplicate();
await Promise.all([pub.connect(), sub.connect()]);
io.adapter(createAdapter(pub, sub));
```

**2. Move presence into Redis** — replace the `sockets` and `activeCall` maps
with Redis sets/keys so every instance reads the same state.

**3. Sticky sessions** — required if you keep the HTTP long-polling fallback.
In nginx use `ip_hash`, or set `transports: ['websocket']` on the client and
skip stickiness.

`resetPersistedPresence()` at boot clears `isOnline` for *all* users, which is
correct for one process but wrong for many — gate it behind a leader election
or drop it once presence is in Redis.

---

## 9. Capacity planning

Signalling is cheap; media is peer-to-peer. One modest VM handles thousands of
concurrent idle connections.

| Resource | Notes |
|---|---|
| Signalling bandwidth | A few KB per call setup, then near-zero |
| Relayed call (TURN) | ~40 kbps up + 40 kbps down, per call |
| Memory | ~10 KB per connected socket |
| MongoDB | One document per call; a few hundred bytes each |

Plan TURN bandwidth for the fraction of calls that need a relay, not all of
them. That fraction is what actually costs money.

---

## 10. Monitoring

`GET /api/health` returns `503` when Mongo is down — point your load balancer
or uptime monitor at it.

Worth watching:

- Ratio of `status: "failed"` / `"unavailable"` calls in the `calls` collection
- Distribution of `connectionType` — a rising `relay` share means TURN load
- `quality.*.rating` trending toward `poor`
- Socket connection count vs. active call count

Logs go to stdout (`server/utils/logger.js`); set `LOG_LEVEL` to `error`,
`warn`, `info` or `debug`. Collect with `journalctl`, Docker logs, or any log
shipper.

---

## 11. Security notes

Already in place:

- Helmet with a restrictive CSP (no inline scripts)
- CORS locked to `CLIENT_ORIGIN`
- Rate limits on auth, search and general API traffic
- bcrypt cost 12; constant-time login regardless of account existence
- Refresh-token rotation with reuse detection
- Refresh tokens stored as SHA-256 digests
- Regex escaping on user search input
- Participant checks on every signalling event — a third party cannot inject
  SDP into someone else's call
- Body size capped at 100 KB

Worth adding for a public deployment:

- Phone/email verification on registration (there is none today)
- Per-user call-rate limiting to deter spam dialling
- Account lockout after repeated failed logins
- Blocking a contact
- An abuse-report path
