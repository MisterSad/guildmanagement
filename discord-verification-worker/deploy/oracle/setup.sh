#!/usr/bin/env bash
# Install OR update the Discord Gateway worker on an Ubuntu VM (Oracle Cloud
# Always Free, Ubuntu 22.04/24.04, arm64 or x86_64). Idempotent: the first run
# installs everything, every later run pulls main, reinstalls dependencies and
# restarts the bot.
#
#   curl -fsSL https://raw.githubusercontent.com/MisterSad/guildmanagement/main/discord-verification-worker/deploy/oracle/setup.sh | sudo bash
#
# It never writes a secret: the env file is created from env.example, empty,
# and the bot is only started once its required variables are filled in.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MisterSad/guildmanagement.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/fgf-guild-management}"
WORKER_DIR="$APP_DIR/discord-verification-worker"
DEPLOY_DIR="$WORKER_DIR/deploy/oracle"
ENV_DIR="/etc/fgf-discord-bot"
ENV_FILE="$ENV_DIR/env"
SERVICE="fgf-discord-bot"
BOT_USER="fgfbot"
NODE_MAJOR=22
# Set by the test harness to run everything except systemd calls.
NO_SYSTEMD="${NO_SYSTEMD:-0}"

log() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash setup.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log "Base packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg >/dev/null

current_node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]'
}
if [ "$(current_node_major)" -lt "$NODE_MAJOR" ]; then
  log "Node.js $NODE_MAJOR (NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v), npm $(npm -v)"

if ! id "$BOT_USER" >/dev/null 2>&1; then
  log "System user $BOT_USER"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$BOT_USER"
fi

# The code stays root-owned: the bot can read it but never modify it.
if [ -d "$APP_DIR/.git" ]; then
  log "Updating $APP_DIR to origin/$BRANCH"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  # A plain shallow clone: `clone --sparse` breaks on the git 2.25 that
  # Ubuntu 20.04 ships. A leftover from an interrupted clone is removed first.
  rm -rf "$APP_DIR"
  log "Cloning $REPO_URL into $APP_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
log "Code at $(git -C "$APP_DIR" log -1 --format='%h %s')"

log "Dependencies (npm ci, production only, no install scripts)"
(cd "$WORKER_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error)
chmod -R go-w "$APP_DIR"
chmod -R a+rX "$APP_DIR"

install -d -m 0700 -o root -g root "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  log "Creating $ENV_FILE from env.example (empty, fill it in)"
  install -m 0600 -o root -g root "$DEPLOY_DIR/env.example" "$ENV_FILE"
fi
chmod 0600 "$ENV_FILE"

missing=()
for name in DISCORD_BOT_TOKEN SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY VERIFICATION_FUNCTION_URL DISCORD_WORKER_SECRET; do
  # Look for a non-empty assignment without ever printing the value.
  if ! grep -Eq "^${name}=.+" "$ENV_FILE"; then missing+=("$name"); fi
done

if [ "$NO_SYSTEMD" = "1" ]; then
  log "NO_SYSTEMD=1: skipping systemd. Missing variables: ${missing[*]:-none}"
  exit 0
fi

log "systemd units"
install -m 0644 "$DEPLOY_DIR/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
install -m 0644 "$DEPLOY_DIR/$SERVICE-heartbeat.service" "/etc/systemd/system/$SERVICE-heartbeat.service"
install -m 0644 "$DEPLOY_DIR/$SERVICE-heartbeat.timer" "/etc/systemd/system/$SERVICE-heartbeat.timer"
systemctl daemon-reload
systemctl enable --quiet "$SERVICE.service" "$SERVICE-heartbeat.timer"
systemctl start "$SERVICE-heartbeat.timer"

if [ "${#missing[@]}" -gt 0 ]; then
  systemctl stop "$SERVICE.service" 2>/dev/null || true
  cat <<EOF

The bot is installed but NOT started: these variables are empty in $ENV_FILE
  ${missing[*]}
Fill them in:   sudo nano $ENV_FILE
Then re-run this script, or:   sudo systemctl restart $SERVICE
EOF
  exit 0
fi

log "Restarting $SERVICE"
systemctl restart "$SERVICE.service"
sleep 8
if systemctl is-active --quiet "$SERVICE.service"; then
  echo "Running. Recent log:"
  journalctl -u "$SERVICE" -n 20 --no-pager
else
  echo "The bot did not stay up. Log:" >&2
  journalctl -u "$SERVICE" -n 50 --no-pager >&2
  exit 1
fi
