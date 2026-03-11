# Personal WhatsApp Bot (Baileys)

A practical **personal-use** WhatsApp bot built with Baileys, inspired by feature-rich bots (like Levanter-style utility packs) but kept simple to deploy on a VPS.

## Main Features

- Owner + authorized-user command access
- Productivity tools:
  - `!note add/list/del`
  - `!todo add/done/list/del`
  - `!remind 10m message`
  - `!quote`, `!quote add`
- Automation:
  - `!auto add/list/del` keyword responses
- Privacy/event tooling:
  - Deleted message log + forwarding
  - Anti view-once capture (auto forward media + metadata)
  - Status saver (save status media from contacts + forward to selected chats)
- Privacy toggles from `.env`:
  - hide online
  - hide chat read receipts
  - hide status viewed receipts
- VPS-ready with `systemd`
- Auto Node.js alignment with `nvm` via `setup.sh`

## Commands

- `!help`
- `!ping`
- `!whoami`
- `!echo <text>`
- `!note add <text>`
- `!note list`
- `!note del <id>`
- `!todo add <text>`
- `!todo done <id>`
- `!todo list`
- `!todo del <id>`
- `!remind <10m|2h|1d> <message>`
- `!quote`
- `!quote add <text>`
- `!auto add <keyword> | <response>`
- `!auto list`
- `!auto del <keyword>`
- `!stats`

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Scan QR from terminal on first run.

## One-shot Setup Script (recommended)

Use the provided raw bash setup script. It will:
- clone repo (if not already in repo)
- install base packages (Ubuntu)
- install/use correct Node version via `nvm`
- install dependencies
- create `.env` if missing
- run syntax check

```bash
bash setup.sh
```

You can also run it from raw URL on VPS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/abyn365/personal-wabot/main/setup.sh)
```

Optional overrides:

```bash
REPO_URL=https://github.com/abyn365/personal-wabot TARGET_DIR=personal-wabot NODE_VERSION=20 bash setup.sh
```

## Environment Variables

| Variable | Description |
|---|---|
| `BOT_NAME` | Bot name in help menu |
| `BOT_PREFIX` | Command prefix |
| `OWNER_NUMBERS` | Comma-separated owners (international format, no `+`) |
| `AUTHORIZED_NUMBERS` | Additional numbers allowed to use commands |
| `LOG_LEVEL` | pino log level |
| `AUTH_DIR` | Baileys auth state path |
| `DB_FILE` | JSON datastore path |
| `STATUS_DIR` | Saved status/view-once media path |
| `HIDE_ONLINE` | Keep bot presence hidden on connect |
| `HIDE_READ_CHAT` | Disable automatic read receipts in chats |
| `HIDE_STATUS_VIEW` | Disable status viewed receipts |
| `FORWARD_EVENTS_TO_OWNER` | Forward logs/events to owners |
| `FORWARD_EVENTS_TO_AUTH_USERS` | Forward logs/events to authorized users |
| `EVENT_FORWARD_JIDS` | Extra chats/JIDs for event logs |
| `VIEW_ONCE_FORWARD_JIDS` | Extra chats/JIDs for anti-view-once captures |
| `STATUS_FORWARD_JIDS` | Extra chats/JIDs for status saver outputs |

## VPS Deployment (Ubuntu + systemd)

### 1. Setup app

```bash
git clone https://github.com/abyn365/personal-wabot
cd personal-wabot
bash setup.sh
nano .env
```

### 2. Pair bot account

```bash
npm start
```

Scan QR, then stop with `Ctrl + C`.

### 3. Create systemd service

```bash
sudo nano /etc/systemd/system/personal-wabot.service
```

```ini
[Unit]
Description=Personal WhatsApp Bot (Baileys)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/personal-wabot
ExecStart=/usr/bin/bash -lc 'source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npm start'
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable/start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable personal-wabot
sudo systemctl start personal-wabot
sudo systemctl status personal-wabot
```

### 4. Logs and maintenance

```bash
sudo journalctl -u personal-wabot -f
sudo systemctl restart personal-wabot
```

## Important Notes

- Anti view-once and status saver work best for media statuses/messages.
- Reminder jobs are in-memory (cleared on restart).
- Keep `.env` and `data/auth` private.
- Prefer using a dedicated WhatsApp account for automation.
