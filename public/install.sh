#!/usr/bin/env bash
set -e

# SysWatch Agent Installer
# Usage: curl -sSL https://your-backend.com/install.sh | SYSWATCH_URL=https://your-backend.com AGENT_KEY=sk-agent-xxx bash

SYSWATCH_URL="${SYSWATCH_URL:-http://localhost:3001}"
AGENT_KEY="${AGENT_KEY:-}"
AGENT_NAME="${AGENT_NAME:-$(hostname)}"
INTERVAL="${INTERVAL:-5000}"
INSTALL_DIR="${HOME}/.syswatch-agent"
CONFIG_DIR="${HOME}/.syswatch"
CONFIG_FILE="${CONFIG_DIR}/config"
SERVICE_FILE="/etc/systemd/system/syswatch-agent.service"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[SysWatch]${NC} $1"; }
warn()  { echo -e "${YELLOW}[SysWatch]${NC} $1"; }
error() { echo -e "${RED}[SysWatch]${NC} $1"; exit 1; }
info()  { echo -e "${BLUE}[SysWatch]${NC} $1"; }

if [ -z "$AGENT_KEY" ]; then
  error "AGENT_KEY is required. Get it from your SysWatch dashboard when adding a server."
fi

log "Installing SysWatch Agent..."
info "  Server name : $AGENT_NAME"
info "  Backend URL : $SYSWATCH_URL"

# ---- Root check (optional — needed only for systemd install) ----
ROOT=false
if [ "$EUID" -eq 0 ]; then
  ROOT=true
fi

# ---- Node.js ----
if ! command -v node &>/dev/null; then
  if [ "$ROOT" = false ]; then
    error "Node.js not found. Install Node.js >= 18 and re-run, or run as root so the script can install it."
  fi
  warn "Node.js not found. Installing via NodeSource (LTS)..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash -
    yum install -y nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash -
    dnf install -y nodejs
  else
    error "Unsupported package manager. Install Node.js >= 18 manually and re-run."
  fi
fi

NODE_VERSION=$(node --version)
log "Node.js $NODE_VERSION detected"

# ---- Install agent package ----
log "Installing syswatch-agent npm package..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

cat > package.json <<'PKGJSON'
{
  "name": "syswatch-agent-runtime",
  "version": "1.0.0",
  "dependencies": {
    "systeminformation": "^5.22.11"
  }
}
PKGJSON

npm install --omit=dev --quiet

# Download agent script
curl -sSL "${SYSWATCH_URL}/agent.js" -o "${INSTALL_DIR}/agent.js" 2>/dev/null || {
  warn "Could not download agent.js from ${SYSWATCH_URL}/agent.js"
  warn "Make sure your backend is reachable and serving /agent.js"
  exit 1
}

# ---- Write config ----
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_FILE" <<CONF
SYSWATCH_URL=${SYSWATCH_URL}
AGENT_KEY=${AGENT_KEY}
AGENT_NAME=${AGENT_NAME}
INTERVAL=${INTERVAL}
CONF
chmod 600 "$CONFIG_FILE"
log "Config written to $CONFIG_FILE"

# ---- Systemd service ----
if ! command -v systemctl &>/dev/null || [ "$ROOT" = false ]; then
  warn "Running without systemd (no root). Starting agent in background..."
  LOGFILE="${HOME}/syswatch-agent.log"
  nohup node "${INSTALL_DIR}/agent.js" > "$LOGFILE" 2>&1 &
  log "Agent started (PID $!). Logs: tail -f $LOGFILE"
  exit 0
fi

cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=SysWatch Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONFIG_FILE}
ExecStart=$(which node) ${INSTALL_DIR}/agent.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=syswatch-agent
User=root

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable syswatch-agent
systemctl restart syswatch-agent

log ""
log "✓ SysWatch Agent installed and started!"
log ""
info "  Status : systemctl status syswatch-agent"
info "  Logs   : journalctl -u syswatch-agent -f"
info "  Stop   : systemctl stop syswatch-agent"
