#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/abyn365/personal-wabot}"
TARGET_DIR="${TARGET_DIR:-personal-wabot}"
NODE_VERSION="${NODE_VERSION:-$(cat .nvmrc 2>/dev/null || echo 20)}"

log() { printf "\n[setup] %s\n" "$1"; }
warn() { printf "\n[setup][warn] %s\n" "$1"; }
err() { printf "\n[setup][error] %s\n" "$1"; }
trap 'err "Failed at line $LINENO while running: $BASH_COMMAND"' ERR

run_as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

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

ensure_repo_context() {
  if [[ ! -f package.json ]]; then
    log "Cloning repository ${REPO_URL} into ${TARGET_DIR}"
    git clone "$REPO_URL" "$TARGET_DIR"
    cd "$TARGET_DIR"
  else
    log "Repository detected in current directory, skipping clone"
  fi
}

install_base_packages() {
  if command -v apt >/dev/null 2>&1; then
    log "Installing base packages (curl, git, build tools)"
    run_as_root apt update -y
    run_as_root apt install -y curl git build-essential ca-certificates
  fi
}

source_nvm_safely() {
  local rc
  # nvm.sh can break under `set -u` and can return non-zero in some shells.
  # Temporarily disable nounset + errexit so we can handle failures ourselves.
  set +u +e
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  rc=$?
  set -e -u
  return "$rc"
}

ensure_nvm_loaded() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    log "Installing nvm into $NVM_DIR"
    mkdir -p "$NVM_DIR"

    if [[ ! -d "$NVM_DIR/.git" ]]; then
      git clone https://github.com/nvm-sh/nvm.git "$NVM_DIR"
    fi

    git -C "$NVM_DIR" fetch --tags origin
    git -C "$NVM_DIR" checkout "$(git -C "$NVM_DIR" describe --abbrev=0 --tags)"
  fi

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    warn "nvm installation failed (nvm.sh missing)."
    warn "Please inspect network/DNS or install nvm manually, then rerun setup.sh."
    exit 1
  fi

  if ! source_nvm_safely; then
    warn "Failed to source $NVM_DIR/nvm.sh on first attempt."
  fi

  if ! command -v nvm >/dev/null 2>&1; then
    warn "nvm could not be loaded in this shell."
    warn "Trying fallback install script..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    if ! source_nvm_safely; then
      warn "Failed to source nvm after fallback install script."
    fi
  fi

  if ! command -v nvm >/dev/null 2>&1; then
    err "nvm still unavailable after fallback install."
    exit 1
  fi
}

ensure_node() {
  log "Ensuring Node.js version ${NODE_VERSION} via nvm"
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"
  log "Using Node $(node -v) and npm $(npm -v)"
}

create_env_interactive() {
  PM2_INSTALL="no"
  PM2_START="no"
  PM2_APP_NAME="personal-wabot"
  AUTO_UPDATE_VALUE="no"
  AUTO_UPDATE_INTERVAL_VALUE="15"
  AUTO_UPDATE_BRANCH_VALUE="main"
  ALLOW_PAIRING_COMMAND_VALUE="no"

  if [[ -f .env ]]; then
    log ".env already exists, leaving it unchanged"
    return
  fi

  log "Creating .env interactively"

  if [[ ! -t 0 ]]; then
    log "Non-interactive shell detected, falling back to .env.example defaults"
    cp .env.example .env
    return
  fi

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
  AUTO_UPDATE_VALUE="$(ask_bool 'Enable auto update (git pull when origin/main changes)? (yes/no)' 'no')"
  AUTO_UPDATE_INTERVAL_VALUE="$(ask 'Auto update check interval minutes' '15')"
  AUTO_UPDATE_BRANCH_VALUE="$(ask 'Auto update branch' 'main')"
  ALLOW_PAIRING_COMMAND_VALUE="$(ask_bool 'Allow in-chat multi-device pairing command? (yes/no)' 'no')"
  PM2_INSTALL="$(ask_bool 'Install PM2 globally? (yes/no)' 'yes')"
  if [[ "$PM2_INSTALL" == "yes" ]]; then
    PM2_START="$(ask_bool 'Start bot with PM2 after setup? (yes/no)' 'yes')"
    PM2_APP_NAME="$(ask 'PM2 app name' 'personal-wabot')"
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
AUTO_UPDATE=${AUTO_UPDATE_VALUE}
AUTO_UPDATE_INTERVAL_MINUTES=${AUTO_UPDATE_INTERVAL_VALUE}
AUTO_UPDATE_BRANCH=${AUTO_UPDATE_BRANCH_VALUE}
ALLOW_PAIRING_COMMAND=${ALLOW_PAIRING_COMMAND_VALUE}
PM2_APP_NAME=${PM2_APP_NAME}
EOL

  export PM2_INSTALL PM2_START PM2_APP_NAME
}

maybe_setup_pm2() {
  local pm2_install="${PM2_INSTALL:-no}"
  local pm2_start="${PM2_START:-no}"
  local pm2_app="${PM2_APP_NAME:-personal-wabot}"

  if [[ "$pm2_install" != "yes" ]]; then
    return
  fi

  log "Installing PM2"
  npm install -g pm2

  if [[ "$pm2_start" == "yes" ]]; then
    log "Starting bot with PM2 (app: ${pm2_app})"
    pm2 delete "$pm2_app" >/dev/null 2>&1 || true
    pm2 start src/index.js --name "$pm2_app"
    pm2 save
    pm2 startup || true
    log "Setup complete. Bot is running with PM2 as '${pm2_app}'."
    log "Useful: pm2 logs ${pm2_app}"
  fi
}

main() {
  ensure_repo_context
  install_base_packages
  ensure_nvm_loaded
  ensure_node

  log "Installing dependencies"
  npm install

  create_env_interactive

  maybe_setup_pm2

  log "Running syntax check"
  npm run check

  if [[ "${PM2_START:-no}" != "yes" ]]; then
    log "Setup complete. Run: npm start"
  fi
}

main "$@"
