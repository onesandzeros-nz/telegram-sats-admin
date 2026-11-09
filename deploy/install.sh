#!/bin/bash
# Install or update the bot as a systemd service on a small Debian/Ubuntu host. Idempotent.
#
#   rsync -a --delete --exclude node_modules --exclude data --exclude .env \
#     --rsync-path="sudo rsync" ./ <host>:/opt/telegram-sats-admin/
#   ssh <host> sudo bash /opt/telegram-sats-admin/deploy/install.sh
#
# First run: adds swap on small instances, installs Node, creates the service user, writes
# /etc/telegram-sats-admin.env with a NEW wallet mnemonic, installs and starts the service.
# Later runs: reinstall dependencies and restart. The env file is never overwritten.
set -euo pipefail

APP_DIR=/opt/telegram-sats-admin
DATA_DIR=/var/lib/telegram-sats-admin
ENV_FILE=/etc/telegram-sats-admin.env
NODE_VERSION=v26.8.2
SVC=telegram-sats-admin
SVC_USER=satsadmin

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -f "$APP_DIR/package.json" ] || { echo "sync the project to $APP_DIR first"; exit 1; }

echo "==> swap"
if [ ! -f /swapfile ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1500 ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    added 1G swapfile"
else
  echo "    ok"
fi

echo "==> node $NODE_VERSION"
if ! command -v node >/dev/null 2>&1 || [ "$(node --version)" != "$NODE_VERSION" ]; then
  case "$(uname -m)" in
    aarch64) NODE_ARCH=arm64 ;;
    x86_64) NODE_ARCH=x64 ;;
    *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
  esac
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
fi
echo "    $(node --version), npm $(npm --version)"

echo "==> service user and data dir"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$DATA_DIR"
chown "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> dependencies"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund 2>&1 | grep -v '^npm warn install-scripts' || true
[ -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ] || { echo "better-sqlite3 native module missing"; exit 1; }
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

echo "==> env file"
if [ ! -f "$ENV_FILE" ]; then
  MNEMONIC=$(node scripts/new-mnemonic.mjs)
  umask 077
  cat > "$ENV_FILE" <<ENV
# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=""
# Breez SDK API key
BREEZ_API_KEY=""
# Wallet seed. Generated on $(date -u +%Y-%m-%dT%H:%MZ). BACK THIS UP: it is the only key to the collected sats.
BREEZ_MNEMONIC="$MNEMONIC"
BREEZ_NETWORK="mainnet"
ENTRY_FEE_SATS="1000"
INVOICE_EXPIRY_SECS="86400"
DATA_DIR="$DATA_DIR"
LOG_LEVEL="info"
ENV
  umask 022
  echo "    created $ENV_FILE with a NEW wallet mnemonic"
else
  echo "    keeping existing $ENV_FILE"
fi
chmod 600 "$ENV_FILE"

echo "==> systemd"
install -m 644 deploy/$SVC.service /etc/systemd/system/$SVC.service
install -m 755 deploy/sats-wallet /usr/local/bin/sats-wallet
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
systemctl restart "$SVC" || true
sleep 4
systemctl --no-pager --lines=0 status "$SVC" || true
echo
echo "logs:   journalctl -u $SVC -f"
echo "config: $ENV_FILE  (then: sudo systemctl restart $SVC)"
