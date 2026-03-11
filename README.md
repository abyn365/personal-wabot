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
- `!remind <10m|2h|1d> <message>` — set reminder
- `!remind list` — list active reminders
- `!remind cancel <id>` — cancel reminder
- `!schedule text <time> <jid|current> <text>` — schedule a text message
- `!schedule fwd <time> <jid|current>` — reply to any message, then schedule forwarding
- `!schedule list` — list your schedules
- `!schedule cancel <id>` — cancel schedule
- `!sticker` — reply an image to convert into sticker with metadata
- `!quote` — get random quote
- `!quote add <text>` — add quote
- `!auto add <keyword> | <response>` — add auto reply rule
- `!auto list` — list auto reply rules
- `!auto del <keyword>` — delete auto reply rule
- `!afk on <message>` — enable AFK mode
- `!afk off` — disable AFK mode
- `!afk status` — check AFK status
- `!stats` — summary stats

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

On first run, scan the QR shown in terminal.

## Interactive VPS Setup Script

```bash
bash setup.sh
```

What it does:
- clone repo (if needed)
- install base packages
- install/use Node via `nvm` based on `.nvmrc`
- install dependencies
- create `.env` **interactively** via prompts (including language `en/id` and sticker pack metadata)
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

## VPS + systemd

1) Prepare and configure:

```bash
git clone https://github.com/abyn365/personal-wabot
cd personal-wabot
bash setup.sh
nano .env
```

2) Pair account:

```bash
npm start
```

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
- Keep `.env` and `data/auth` private.
- Use dedicated WhatsApp account for automation.
