#!/usr/bin/env bash
#
# One-shot bootstrap for a fresh Ubuntu/Debian VM.
#
#   curl -fsSL https://raw.githubusercontent.com/Zenil-20/Caller/main/deploy/setup.sh | bash -s -- gians.duckdns.org
#
# ...or, having already cloned the repo:
#
#   ./deploy/setup.sh gians.duckdns.org
#
# Generates every secret, writes .env, configures TURN, and starts the stack.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <your-domain>" >&2
  echo "Example: $0 gians.duckdns.org" >&2
  exit 1
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "Checking prerequisites"
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  warn "You were added to the docker group. Log out and back in if docker commands need sudo."
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin missing; install it and re-run." >&2
  exit 1
fi

if [[ ! -f docker-compose.prod.yml ]]; then
  say "Cloning the repository"
  git clone https://github.com/Zenil-20/Caller.git gians
  cd gians
fi

# ---------------------------------------------------------------------------
say "Detecting the public IP"
# ---------------------------------------------------------------------------
# TURN must advertise the address clients can actually reach. On a cloud VM the
# interface usually holds a private address, so ask an external service.
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
PRIVATE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
echo "public:  $PUBLIC_IP"
echo "private: ${PRIVATE_IP:-none}"

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
if [[ "$RESOLVED" != "$PUBLIC_IP" ]]; then
  warn "$DOMAIN resolves to '${RESOLVED:-nothing}', not $PUBLIC_IP."
  warn "Point the DNS record at this server or Let's Encrypt will refuse to issue a certificate."
  read -r -p "Continue anyway? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1
fi

# ---------------------------------------------------------------------------
say "Generating secrets"
# ---------------------------------------------------------------------------
gen() { openssl rand -hex 48; }
TURN_SECRET="$(openssl rand -hex 32)"

# web-push needs node; use the container so the host stays clean.
VAPID_JSON="$(docker run --rm node:20-alpine sh -c \
  'npm i -s web-push >/dev/null 2>&1 && node -e "console.log(JSON.stringify(require(\"web-push\").generateVAPIDKeys()))"')"
VAPID_PUBLIC="$(echo "$VAPID_JSON"  | sed -E 's/.*"publicKey":"([^"]+)".*/\1/')"
VAPID_PRIVATE="$(echo "$VAPID_JSON" | sed -E 's/.*"privateKey":"([^"]+)".*/\1/')"

if [[ -f .env ]]; then
  cp .env ".env.backup.$(date +%s)"
  warn "Existing .env backed up."
fi

cat > .env <<EOF
NODE_ENV=production
PORT=4000
DOMAIN=${DOMAIN}
ACME_EMAIL=admin@${DOMAIN}
CLIENT_ORIGIN=https://${DOMAIN}

MONGODB_URI=mongodb://mongo:27017/gians_voip

JWT_ACCESS_SECRET=$(gen)
JWT_REFRESH_SECRET=$(gen)
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:${DOMAIN}:3478,turns:${DOMAIN}:5349
TURN_STATIC_SECRET=${TURN_SECRET}
TURN_CREDENTIAL_TTL=86400

VAPID_PUBLIC_KEY=${VAPID_PUBLIC}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE}
VAPID_SUBJECT=mailto:admin@${DOMAIN}

RING_TIMEOUT_MS=45000
EOF
chmod 600 .env

# ---------------------------------------------------------------------------
say "Configuring TURN"
# ---------------------------------------------------------------------------
EXTERNAL_LINE="$PUBLIC_IP"
# Behind cloud NAT, coturn needs the public/private mapping to advertise
# candidates the far side can actually use.
if [[ -n "${PRIVATE_IP:-}" && "$PRIVATE_IP" != "$PUBLIC_IP" ]]; then
  EXTERNAL_LINE="${PUBLIC_IP}/${PRIVATE_IP}"
fi

sed -i "s|^external-ip=.*|external-ip=${EXTERNAL_LINE}|" deploy/turnserver.conf
sed -i "s|^realm=.*|realm=${DOMAIN}|"                     deploy/turnserver.conf
sed -i "s|^server-name=.*|server-name=${DOMAIN}|"         deploy/turnserver.conf
sed -i "s|^static-auth-secret=.*|static-auth-secret=${TURN_SECRET}|" deploy/turnserver.conf

# ---------------------------------------------------------------------------
say "Opening the firewall"
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 22/tcp        >/dev/null 2>&1 || true
  sudo ufw allow 80,443/tcp    >/dev/null 2>&1 || true
  sudo ufw allow 3478,5349/tcp >/dev/null 2>&1 || true
  sudo ufw allow 3478,5349/udp >/dev/null 2>&1 || true
  sudo ufw allow 49152:65535/udp >/dev/null 2>&1 || true
  sudo ufw --force enable      >/dev/null 2>&1 || true
  echo "ufw configured."
fi
warn "Your cloud provider has a SEPARATE firewall. Open 80, 443, 3478, 5349 and UDP 49152-65535 there too."

# ---------------------------------------------------------------------------
say "Starting the stack"
# ---------------------------------------------------------------------------
mkdir -p backups
docker compose -f docker-compose.prod.yml up -d --build

say "Waiting for the app to become healthy"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:80" >/dev/null 2>&1 || \
     docker compose -f docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo "app is up."
    break
  fi
  sleep 3
done

say "Done"
cat <<EOF

  App:     https://${DOMAIN}
  Health:  https://${DOMAIN}/api/health

  Certificates can take a minute on first boot. If HTTPS is not ready yet:
    docker compose -f docker-compose.prod.yml logs -f caddy

  Create demo accounts (optional):
    docker compose -f docker-compose.prod.yml exec app npm run seed

  Then, on each phone: open the URL, sign in, and install the app.
    Android : Settings -> Install app
    iPhone  : Safari -> Share -> Add to Home Screen  (required for ringing)

  Verify TURN before trusting it on mobile data:
    https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
    Use credentials from https://${DOMAIN}/api/calls/ice-servers and confirm a
    candidate of type "relay" appears.

EOF
