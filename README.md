# Personal WhatsApp Bot (Baileys)

Personal WhatsApp bot built with Baileys, designed for VPS deployment with a practical command set, localization, advanced scheduler, and event logging.

## Main Features

- Owner + authorized-user command access
- Localization via `.env` (`BOT_LANG=en|id`)
- Productivity toolkit:
  - notes (`add/list/find/del`)
  - todos (`add/done/list/del`)
  - reminders (`create/list/cancel`)
  - quotes (`random/add`)
- Utility commands:
  - chat id lookup
  - uptime
  - whoami
- AFK mode with auto notice reply for non-authorized chats
- Automation:
  - keyword auto responders
- Sticker creator from replied images with packname/author metadata
- **Message scheduler**:
  - schedule text messages to any JID
  - schedule forwarded replied messages (supports many chat/media types by forwarding original quoted payload)
  - schedule list/cancel
- Monitoring/logging:
  - deleted-message details with forwarding
  - anti view-once capture + forwarding
  - status saver (save + forward)
- Privacy controls from `.env`:
  - hide online
  - hide chat read receipts
  - hide status viewed receipts
- Auto Node version alignment via `nvm`

## Command Overview

- `!help` — show all commands with descriptions
- `!ping` — quick health check
- `!whoami` — show your sender JID
- `!chatid` — show current chat JID
- `!uptime` — show current bot uptime
- `!echo <text>` — repeat text
- `!note add <text>` — add note
- `!note list` — list notes
- `!note find <keyword>` — search notes
- `!note del <id>` — delete note
- `!todo add <text>` — add todo item
- `!todo done <id>` — mark todo complete
- `!todo list` — list todos
- `!todo del <id>` — delete todo
- `!remind <time plan> <message>` — set reminder (`1h 15m` or `11/03/2026 1h 15m`)
- `!remind list` — list active reminders
- `!remind cancel <id>` — cancel reminder
- `!schedule text <time plan> <jid|current> <text>` — schedule a text message
- `!schedule fwd <time plan> <jid|current>` — reply to any message, then schedule forwarding
- `!schedule list` — list your schedules
- `!schedule cancel <id>` — cancel schedule
- `!sticker` — reply an image to convert into sticker with metadata
- `!pair <number>` — request MD pairing code for additional device/number (if enabled)
- `!quote` — get random quote
- `!quote add <text>` — add quote
- `!auto add <keyword> | <response>` — add auto reply rule
- `!auto list` — list auto reply rules
- `!auto del <keyword>` — delete auto reply rule
- `!afk on <message>` — enable AFK mode
- `!afk off` — disable AFK mode
- `!afk status` — check AFK status
- `!stats` — summary stats

## Time Planning Format

All scheduling/reminder features use the same format:

- `1h 15m` → execute 1 hour 15 minutes after command
- `11/03/2026 1h 15m` → execute on 11 March 2026 at 01:15 (date at 00:00 plus duration)

You can combine units like `2h 5m`, `1d 3h`, etc.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

On first run, complete login from terminal output:
- use the printed pairing code (Linked Devices -> Link with phone number)
- ensure `OWNER_NUMBERS` is set correctly, because startup pairing code is sent for the first owner number

## Interactive VPS Setup Script

```bash
bash setup.sh
```

What it does:
- clone repo (if needed)
- install base packages
- install/use Node via `nvm` based on `.nvmrc`
- install dependencies
- create `.env` **interactively** via prompts (including language `en/id`, sticker pack metadata, auto-update and pairing flags)
- optional PM2 install + auto-start
- run syntax check

Raw script usage:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/abyn365/personal-wabot/main/setup.sh)
```

## Environment Variables

See `.env.example` for full options:
- localization (`BOT_LANG=en|id`)
- sticker metadata (`STICKER_PACKNAME=PackName,Author`)
- auth/access (`OWNER_NUMBERS`, `AUTHORIZED_NUMBERS`)
- privacy (`HIDE_ONLINE`, `HIDE_READ_CHAT`, `HIDE_STATUS_VIEW`)
- forwarding (`EVENT_FORWARD_JIDS`, `VIEW_ONCE_FORWARD_JIDS`, `STATUS_FORWARD_JIDS`)
- paths (`AUTH_DIR`, `DB_FILE`, `STATUS_DIR`)
- auto update (`AUTO_UPDATE`, `AUTO_UPDATE_INTERVAL_MINUTES`, `AUTO_UPDATE_BRANCH`)
- MD pairing command (`ALLOW_PAIRING_COMMAND`)
- auto-clear stale auth on forced logout (`AUTO_CLEAR_AUTH_ON_LOGOUT=false`)

## VPS + systemd (recommended if not using PM2)

1) Prepare and configure:

```bash
git clone https://github.com/abyn365/personal-wabot
cd personal-wabot
bash setup.sh
nano .env
```

2) Pair account (`npm start`):

```bash
npm start
```

Then watch logs for `Pairing code generated` and enter that code in WhatsApp Linked Devices.

3) Create service:

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

4) Enable service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable personal-wabot
sudo systemctl start personal-wabot
sudo journalctl -u personal-wabot -f
```

## Notes

- Reminder jobs and scheduler jobs are restored from JSON and executed by timers.
- `schedule fwd` requires replying to a message to capture its payload.
- Auto update runs `git fetch/pull` when enabled and can restart via PM2 if `PM2_APP_NAME` is set.
- Keep `.env` and `data/auth` private.
- Use dedicated WhatsApp account for automation.


## VPS + PM2 (optional)

If you prefer PM2 instead of systemd, setup script can install/start PM2 automatically. Setup is idempotent: rerunning `bash setup.sh` is safe.

Manual PM2 commands:

```bash
npm install -g pm2
pm2 start src/index.js --name personal-wabot
pm2 save
pm2 startup
pm2 logs personal-wabot
pm2 restart personal-wabot
pm2 stop personal-wabot
```


## Setup Troubleshooting

- If setup stops before prompts, rerun with debug: `bash -x setup.sh` (now includes explicit error line + failing command).
- Setup now safely sources nvm with `set +u` compatibility, which fixes cases where script exits right after apt step.
- New setup flow uses git-based nvm bootstrap first, then fallback installer if nvm still missing.
- If `.env` already exists, setup intentionally keeps it unchanged; delete `.env` to re-run interactive prompts.
- Non-root users are supported via automatic `sudo` for apt steps.
- If logs show `code: 401` + `Session logged out`, enable `AUTO_CLEAR_AUTH_ON_LOGOUT=true` only after initial linking is completed.
- During initial phone-number pairing, logout events keep auth untouched so the latest pairing code remains usable (no regeneration loop).
