#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/abyn365/personal-wabot}"
TARGET_DIR="${TARGET_DIR:-personal-wabot}"
NODE_VERSION="${NODE_VERSION:-$(cat .nvmrc 2>/dev/null || echo 20)}"

log() { printf "\n[setup] %s\n" "$1"; }

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

if [[ -z "${NVM_DIR:-}" ]]; then
  export NVM_DIR="$HOME/.nvm"
fi

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

CURRENT_NODE="$(node -v)"
CURRENT_NPM="$(npm -v)"
log "Using Node ${CURRENT_NODE} and npm ${CURRENT_NPM}"

log "Installing dependencies"
npm install

if [[ ! -f .env ]]; then
  log "Creating .env from .env.example"
  cp .env.example .env
fi

log "Running syntax check"
npm run check

log "Setup complete. Edit .env then run: npm start"
