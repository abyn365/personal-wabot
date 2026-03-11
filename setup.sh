#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/abyn365/personal-wabot}"
TARGET_DIR="${TARGET_DIR:-personal-wabot}"
NODE_VERSION="${NODE_VERSION:-$(cat .nvmrc 2>/dev/null || echo 20)}"

log() { printf "\n[setup] %s\n" "$1"; }
ask() {
  local prompt="$1"
  local default="$2"
  local value
  read -r -p "$prompt [$default]: " value || true
  echo "${value:-$default}"
}
ask_bool() {
  local prompt="$1"
  local default="$2"
  local value
  read -r -p "$prompt [$default]: " value || true
  value="${value:-$default}"
  [[ "$value" =~ ^([Yy]|[Yy]es|true|1)$ ]] && echo "yes" || echo "no"
}

if [[ ! -f package.json ]]; then
  log "Cloning repository ${REPO_URL} into ${TARGET_DIR}"
  git clone "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
else
  log "Repository detected in current directory, skipping clone"
fi

if command -v apt >/dev/null 2>&1; then
  log "Installing base packages (curl, git, build tools)"
  sudo apt update -y
  sudo apt install -y curl git build-essential ca-certificates
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  log "Installing nvm"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

# shellcheck source=/dev/null
source "$NVM_DIR/nvm.sh"

log "Ensuring Node.js version ${NODE_VERSION} via nvm"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
nvm alias default "$NODE_VERSION"

log "Using Node $(node -v) and npm $(npm -v)"

log "Installing dependencies"
npm install


PM2_INSTALL="no"
PM2_START="no"
PM2_APP_NAME="personal-wabot"

if [[ ! -f .env ]]; then
  log "Creating .env interactively"

  if [[ -t 0 ]]; then
    BOT_NAME_VALUE="$(ask 'Bot name' 'PersonalBot')"
    BOT_PREFIX_VALUE="$(ask 'Command prefix' '!')"
    BOT_LANG_VALUE="$(ask 'Bot language (en/id)' 'en')"
    STICKER_PACKNAME_VALUE="$(ask 'Sticker packname,author' 'Lmao,made by ABYN')"
    OWNER_NUMBERS_VALUE="$(ask 'Owner numbers (comma-separated, no +)' '6281234567890')"
    AUTHORIZED_NUMBERS_VALUE="$(ask 'Additional authorized numbers (comma-separated, optional)' '')"
    HIDE_ONLINE_VALUE="$(ask 'Hide online presence? (true/false)' 'true')"
    HIDE_READ_CHAT_VALUE="$(ask 'Hide read receipts in chat? (true/false)' 'true')"
    HIDE_STATUS_VIEW_VALUE="$(ask 'Hide status viewed receipts? (true/false)' 'true')"
    EVENT_FORWARD_JIDS_VALUE="$(ask 'Extra log forwarding JIDs (comma-separated, optional)' '')"
    VIEW_ONCE_FORWARD_JIDS_VALUE="$(ask 'Extra view-once forwarding JIDs (comma-separated, optional)' '')"
    STATUS_FORWARD_JIDS_VALUE="$(ask 'Extra status forwarding JIDs (comma-separated, optional)' '')"
    PM2_INSTALL="$(ask_bool 'Install PM2 globally? (yes/no)' 'yes')"
    if [[ "$PM2_INSTALL" == "yes" ]]; then
      PM2_START="$(ask_bool 'Start bot with PM2 after setup? (yes/no)' 'yes')"
      PM2_APP_NAME="$(ask 'PM2 app name' 'personal-wabot')"
    fi
  else
    log "Non-interactive shell detected, falling back to .env.example defaults"
    cp .env.example .env
    npm run check
    log "Setup complete. Update .env then run: npm start"
    exit 0
  fi

  cat > .env <<EOL
BOT_NAME=${BOT_NAME_VALUE}
BOT_PREFIX=${BOT_PREFIX_VALUE}
BOT_LANG=${BOT_LANG_VALUE}
OWNER_NUMBERS=${OWNER_NUMBERS_VALUE}
AUTHORIZED_NUMBERS=${AUTHORIZED_NUMBERS_VALUE}
LOG_LEVEL=info
AUTH_DIR=data/auth
DB_FILE=data/store.json
STATUS_DIR=data/status
STICKER_PACKNAME=${STICKER_PACKNAME_VALUE}

HIDE_ONLINE=${HIDE_ONLINE_VALUE}
HIDE_READ_CHAT=${HIDE_READ_CHAT_VALUE}
HIDE_STATUS_VIEW=${HIDE_STATUS_VIEW_VALUE}

FORWARD_EVENTS_TO_OWNER=true
FORWARD_EVENTS_TO_AUTH_USERS=false
EVENT_FORWARD_JIDS=${EVENT_FORWARD_JIDS_VALUE}
VIEW_ONCE_FORWARD_JIDS=${VIEW_ONCE_FORWARD_JIDS_VALUE}
STATUS_FORWARD_JIDS=${STATUS_FORWARD_JIDS_VALUE}
EOL
else
  log ".env already exists, leaving it unchanged"
fi

if [[ "$PM2_INSTALL" == "yes" ]]; then
  log "Installing PM2"
  npm install -g pm2

  if [[ "$PM2_START" == "yes" ]]; then
    log "Starting bot with PM2 (app: ${PM2_APP_NAME})"
    pm2 delete "$PM2_APP_NAME" >/dev/null 2>&1 || true
    pm2 start src/index.js --name "$PM2_APP_NAME"
    pm2 save
    pm2 startup || true
  fi
fi

log "Running syntax check"
npm run check

if [[ "$PM2_START" == "yes" ]]; then
  log "Setup complete. Bot is running with PM2 as '${PM2_APP_NAME}'."
  log "Useful: pm2 logs ${PM2_APP_NAME}"
else
  log "Setup complete. Run: npm start"
fi
