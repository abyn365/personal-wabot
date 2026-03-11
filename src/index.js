import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import P from 'pino'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
  downloadMediaMessage,
  generateForwardMessageContent,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { Sticker, StickerTypes } from 'wa-sticker-formatter'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'

const logger = P({ level: process.env.LOG_LEVEL || 'info' })
const startTime = Date.now()

const BOT_NAME = process.env.BOT_NAME || 'PersonalBot'
const PREFIX = process.env.BOT_PREFIX || '!'
const BOT_LANG = (process.env.BOT_LANG || 'en').toLowerCase()
const [STICKER_PACK, STICKER_AUTHOR] = (process.env.STICKER_PACKNAME || 'Lmao,made by ABYN').split(',').map((x) => x.trim())
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || 'data/auth')
const DB_FILE = path.resolve(process.env.DB_FILE || 'data/store.json')
const STATUS_DIR = path.resolve(process.env.STATUS_DIR || 'data/status')
const HIDE_ONLINE = toBool(process.env.HIDE_ONLINE, true)
const HIDE_READ_CHAT = toBool(process.env.HIDE_READ_CHAT, true)
const HIDE_STATUS_VIEW = toBool(process.env.HIDE_STATUS_VIEW, true)
const FORWARD_EVENTS_TO_OWNER = toBool(process.env.FORWARD_EVENTS_TO_OWNER, true)
const FORWARD_EVENTS_TO_AUTH_USERS = toBool(process.env.FORWARD_EVENTS_TO_AUTH_USERS, false)
const AUTO_UPDATE = toBool(process.env.AUTO_UPDATE, false)
const AUTO_UPDATE_INTERVAL_MINUTES = Number(process.env.AUTO_UPDATE_INTERVAL_MINUTES || 15)
const AUTO_UPDATE_BRANCH = process.env.AUTO_UPDATE_BRANCH || 'main'
const ALLOW_PAIRING_COMMAND = toBool(process.env.ALLOW_PAIRING_COMMAND, false)

const OWNER_NUMBERS = parseNumbers(process.env.OWNER_NUMBERS)
const AUTHORIZED_NUMBERS = Array.from(new Set([...OWNER_NUMBERS, ...parseNumbers(process.env.AUTHORIZED_NUMBERS)]))
const EVENT_FORWARD_JIDS = parseJids(process.env.EVENT_FORWARD_JIDS)
const VIEW_ONCE_FORWARD_JIDS = parseJids(process.env.VIEW_ONCE_FORWARD_JIDS)
const STATUS_FORWARD_JIDS = parseJids(process.env.STATUS_FORWARD_JIDS)

const reminderJobs = new Map()
const reminderMeta = new Map()
const scheduleJobs = new Map()
const exec = promisify(execCb)

// ─── Helpers ────────────────────────────────────────────────────────────────

function toBool(value, defaultValue = false) {
  if (value === undefined) return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function parseNumbers(raw = '') {
  return raw.split(',').map((x) => x.trim().replace(/\+/g, '')).filter(Boolean)
}

function parseJids(raw = '') {
  return raw.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.includes('@') ? x : `${x.replace(/\+/g, '')}@s.whatsapp.net`))
}

function parseTargetJid(input, currentChatJid) {
  const val = (input || '').trim()
  if (!val || val === 'current' || val === '.') return currentChatJid
  if (val.includes('@')) return val
  return `${val.replace(/\+/g, '')}@s.whatsapp.net`
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function clearAuthDir() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    logger.warn('Cleared stale auth directory.')
  }
  ensureDir(AUTH_DIR)
}

function ensureJsonDb() {
  ensureDir(path.dirname(DB_FILE))
  if (!fs.existsSync(DB_FILE)) {
    const seed = {
      notes: [],
      todos: [],
      autoresponders: {},
      deletedTracker: {},
      quotes: [
        'Focus on systems, not only goals.',
        'Small consistent actions beat occasional intensity.',
        'Document your life so future you can win faster.',
      ],
      afk: { enabled: false, message: 'I am currently AFK.', since: null, by: null },
      schedules: [],
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2))
  }
}

function readDb() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  if (!db.afk) db.afk = { enabled: false, message: 'I am currently AFK.', since: null, by: null }
  if (!db.schedules) db.schedules = []
  return db
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

function nowTs() { return new Date().toISOString() }
function humanTs(ts = Date.now()) { return new Date(ts).toLocaleString() }
function waitMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function formatDuration(ms) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${d}d ${h}h ${m}m ${sec}s`
}

function isAuthorized(senderJid) {
  const normalized = senderJid?.split('@')[0]
  return AUTHORIZED_NUMBERS.length === 0 || AUTHORIZED_NUMBERS.includes(normalized)
}

function parseCommand(text) {
  if (!text?.startsWith(PREFIX)) return null
  const raw = text.slice(PREFIX.length).trim()
  if (!raw) return null
  const [cmd, ...parts] = raw.split(' ')
  return { command: cmd.toLowerCase(), args: parts, fullArgs: parts.join(' ').trim() }
}

function parseDurationToken(token = '') {
  const match = token.match(/^(\d+)([mhd])$/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const multipliers = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  return amount * multipliers[unit]
}

function parseDateToken(token = '') {
  const m = token.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

function parsePlanningTokens(parts = [], startIndex = 0) {
  let i = startIndex
  const date = parseDateToken(parts[i] || '')
  if (date) i += 1

  let durationMs = 0
  while (i < parts.length) {
    const d = parseDurationToken(parts[i])
    if (!d) break
    durationMs += d
    i += 1
  }

  if (durationMs < 10_000 || durationMs > 30 * 86_400_000) return null
  const runAt = date ? new Date(date.getTime() + durationMs).getTime() : Date.now() + durationMs
  return { runAt, consumed: i - startIndex, durationMs, hasDate: Boolean(date) }
}

function parseReminderArgs(args = []) {
  const plan = parsePlanningTokens(args, 0)
  if (!plan) return null
  const message = args.slice(plan.consumed).join(' ').trim()
  if (!message) return null
  return { runAt: plan.runAt, message }
}

function listItems(items, formatter) {
  if (!items.length) return '_No items found._'
  return items.map(formatter).join('\n')
}

function getMessageText(message) {
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || ''
}

function extractViewOnce(message = {}) {
  const container = message.viewOnceMessageV2 || message.viewOnceMessage || message.viewOnceMessageV2Extension
  if (!container?.message) return null
  const inner = container.message
  if (inner.imageMessage) return { type: 'image', inner }
  if (inner.videoMessage) return { type: 'video', inner }
  if (inner.audioMessage) return { type: 'audio', inner }
  if (inner.documentMessage) return { type: 'document', inner }
  return { type: 'unknown', inner }
}

function t(key, vars = {}) {
  const dict = {
    en: {
      unauthorized: '⛔ You are not authorized to use this bot.',
      unknown: `Unknown command. Try ${PREFIX}help`,
      usageRemind: `Usage: ${PREFIX}remind 10m review backup`,
      usageScheduleText: `Usage: ${PREFIX}schedule text 30m <jid|current> your message`,
      usageScheduleFwd: `Usage: reply message then ${PREFIX}schedule fwd 30m <jid|current>`,
      noteNotFound: 'Note ID not found.',
      todoNotFound: 'Todo ID not found.',
      keywordNotFound: 'Keyword not found.',
      reminderNotFound: 'Reminder ID not found.',
      scheduleNotFound: 'Schedule ID not found.',
      afkOn: '✅ AFK enabled.',
      afkOff: '✅ AFK disabled.',
      stickerReply: `Reply to an image with ${PREFIX}sticker`,
      stickerFail: 'Failed to create sticker.',
      pairUsage: `Usage: ${PREFIX}pair 628xxxxxxxxxx`,
      pairDisabled: 'Pair command disabled by config.',
      pairFailed: 'Failed to request pairing code.',
    },
    id: {
      unauthorized: '⛔ Kamu tidak punya akses untuk memakai bot ini.',
      unknown: `Perintah tidak dikenal. Coba ${PREFIX}help`,
      usageRemind: `Contoh: ${PREFIX}remind 10m cek backup`,
      usageScheduleText: `Contoh: ${PREFIX}schedule text 30m <jid|current> isi pesan`,
      usageScheduleFwd: `Contoh: balas pesan lalu ${PREFIX}schedule fwd 30m <jid|current>`,
      noteNotFound: 'ID catatan tidak ditemukan.',
      todoNotFound: 'ID todo tidak ditemukan.',
      keywordNotFound: 'Keyword tidak ditemukan.',
      reminderNotFound: 'ID reminder tidak ditemukan.',
      scheduleNotFound: 'ID schedule tidak ditemukan.',
      afkOn: '✅ Mode AFK aktif.',
      afkOff: '✅ Mode AFK nonaktif.',
      stickerReply: `Balas gambar dengan ${PREFIX}sticker`,
      stickerFail: 'Gagal membuat stiker.',
      pairUsage: `Contoh: ${PREFIX}pair 628xxxxxxxxxx`,
      pairDisabled: 'Perintah pair dimatikan di konfigurasi.',
      pairFailed: 'Gagal meminta kode pairing.',
    },
  }
  const lang = dict[BOT_LANG] ? BOT_LANG : 'en'
  let msg = dict[lang][key] || dict.en[key] || key
  for (const [k, v] of Object.entries(vars)) msg = msg.replaceAll(`{${k}}`, String(v))
  return msg
}

// ─── Destination helpers ─────────────────────────────────────────────────────

function createEventDestinations() {
  const fromOwners = FORWARD_EVENTS_TO_OWNER ? OWNER_NUMBERS.map((n) => `${n}@s.whatsapp.net`) : []
  const fromAuthorized = FORWARD_EVENTS_TO_AUTH_USERS ? AUTHORIZED_NUMBERS.map((n) => `${n}@s.whatsapp.net`) : []
  return Array.from(new Set([...fromOwners, ...fromAuthorized, ...EVENT_FORWARD_JIDS]))
}

function createViewOnceDestinations() {
  return Array.from(new Set([...createEventDestinations(), ...VIEW_ONCE_FORWARD_JIDS]))
}

function createStatusDestinations() {
  return Array.from(new Set([...createEventDestinations(), ...STATUS_FORWARD_JIDS]))
}

async function safeSend(sock, jid, payload, options) {
  try {
    await sock.sendMessage(jid, payload, options)
  } catch (error) {
    logger.warn({ err: error, jid }, 'Failed forwarding message')
  }
}

async function forwardEventLog(sock, title, details, extraJids = []) {
  const targets = Array.from(new Set([...createEventDestinations(), ...extraJids]))
  if (!targets.length) return
  for (const jid of targets) {
    await safeSend(sock, jid, { text: `📌 *${title}*\n${details}\nLogged: ${humanTs()}` })
  }
}

// ─── Auto update ─────────────────────────────────────────────────────────────

function setupAutoUpdate(sock) {
  if (!AUTO_UPDATE) return
  const interval = Math.max(1, AUTO_UPDATE_INTERVAL_MINUTES) * 60_000
  setInterval(() => runAutoUpdate(sock).catch((error) => logger.warn({ err: error }, 'Auto update failed')), interval)
  logger.info({ minutes: AUTO_UPDATE_INTERVAL_MINUTES, branch: AUTO_UPDATE_BRANCH }, 'Auto update enabled')
}

async function runAutoUpdate(sock) {
  await exec(`git fetch origin ${AUTO_UPDATE_BRANCH}`)
  const { stdout: local } = await exec('git rev-parse HEAD')
  const { stdout: remote } = await exec(`git rev-parse origin/${AUTO_UPDATE_BRANCH}`)
  if (local.trim() === remote.trim()) return

  await forwardEventLog(sock, 'Auto Update', `New commit detected on origin/${AUTO_UPDATE_BRANCH}. Pulling updates...`)
  await exec(`git pull --ff-only origin ${AUTO_UPDATE_BRANCH}`)
  await exec('npm install')

  const pm2Name = process.env.PM2_APP_NAME || ''
  if (pm2Name) {
    await exec(`pm2 restart ${pm2Name}`)
    await forwardEventLog(sock, 'Auto Update', `Updated and restarted PM2 app: ${pm2Name}`)
    return
  }

  await forwardEventLog(sock, 'Auto Update', 'Updated successfully. Restart process manually (or use PM2/systemd).')
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

function hydrateSchedules(sock) {
  const db = readDb()
  const now = Date.now()

  db.schedules = db.schedules.filter((item) => {
    if (item.runAt <= now) return false
    registerScheduleJob(sock, item)
    return true
  })

  writeDb(db)
}

function registerScheduleJob(sock, item) {
  if (scheduleJobs.has(item.id)) clearTimeout(scheduleJobs.get(item.id))
  const timeout = setTimeout(async () => {
    try {
      if (item.type === 'text') {
        await sock.sendMessage(item.targetJid, { text: item.text })
      } else {
        const fake = { key: { remoteJid: item.targetJid }, message: item.quotedMessage }
        const content = await generateForwardMessageContent(fake, true)
        const waMsg = await generateWAMessageFromContent(item.targetJid, content, {})
        await sock.relayMessage(item.targetJid, waMsg.message, { messageId: waMsg.key.id })
      }

      await forwardEventLog(
        sock,
        'Scheduled Message Sent',
        `ID: ${item.id}\nType: ${item.type}\nTo: ${item.targetJid}\nBy: ${item.by}\nPlanned: ${humanTs(item.runAt)}`
      )
    } catch (error) {
      logger.warn({ err: error, id: item.id }, 'Failed scheduled send')
    } finally {
      scheduleJobs.delete(item.id)
      const db = readDb()
      db.schedules = db.schedules.filter((s) => s.id !== item.id)
      writeDb(db)
    }
  }, Math.max(1000, item.runAt - Date.now()))

  scheduleJobs.set(item.id, timeout)
}

// ─── Quoted message helpers ──────────────────────────────────────────────────

function getQuotedContextMessage(msg) {
  const source =
    msg.message?.extendedTextMessage ||
    msg.message?.imageMessage ||
    msg.message?.videoMessage ||
    msg.message?.documentMessage

  const ctx = source?.contextInfo
  if (!ctx?.quotedMessage) return null

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      fromMe: false,
      id: ctx.stanzaId,
      participant: ctx.participant || msg.key.participant || msg.key.remoteJid,
    },
    message: ctx.quotedMessage,
  }
}

async function makeStickerFromQuoted(sock, msg) {
  const quoted = getQuotedContextMessage(msg)
  if (!quoted || !quoted.message?.imageMessage) return { error: t('stickerReply') }

  try {
    const buffer = await downloadMediaMessage(quoted, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    if (!buffer?.length) return { error: t('stickerFail') }

    const sticker = new Sticker(buffer, {
      pack: STICKER_PACK || 'Lmao',
      author: STICKER_AUTHOR || 'made by ABYN',
      type: StickerTypes.FULL,
      quality: 80,
    })

    const stickerBuffer = await sticker.toBuffer()
    return { stickerBuffer }
  } catch (error) {
    logger.warn({ err: error }, 'Sticker creation failed')
    return { error: t('stickerFail') }
  }
}

// ─── Core connection ─────────────────────────────────────────────────────────


async function connect() {
  ensureDir(AUTH_DIR)
  ensureDir(STATUS_DIR)
  ensureJsonDb()

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const needsPairing = !state.creds?.registered

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['Ubuntu', 'Chrome', '22.04'],
    markOnlineOnConnect: !HIDE_ONLINE,
    printQRInTerminal: false,
  })

  // ── Credential persistence ────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds)

  // ── Connection state ──────────────────────────────────────────────────────
  let pairingCodeSent = false

  // For new sessions: kick off pairing code after a delay from 'connecting'.
  // We can't use 'open' because WA never fires it during a fresh registration
  // handshake — it stays in 'connecting' until the code is entered.
  // The delay covers the time WA needs to complete the noise handshake and
  // device registration exchange (the "not logged in, attempting registration" step).
  if (needsPairing) {
    const ownerPhone = OWNER_NUMBERS[0]
    if (!ownerPhone) {
      logger.error('OWNER_NUMBERS not set — cannot generate pairing code.')
    } else {
      setTimeout(async () => {
        if (pairingCodeSent) return
        pairingCodeSent = true
        logger.info('Requesting pairing code...')
        try {
          const code = await sock.requestPairingCode(ownerPhone)
          logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
          logger.info(`  PAIRING CODE : ${code}`)
          logger.info(`  Phone        : +${ownerPhone}`)
          logger.info('  WhatsApp → Linked Devices → Link a Device')
          logger.info('  → Link with phone number → enter the code above')
          logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        } catch (err) {
          logger.error({ err }, 'Failed to request pairing code — will retry on next restart.')
          pairingCodeSent = false
        }
      }, 3000)
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (!connection) return
    logger.info({ connection }, 'Connection state changed')

    if (connection === 'open') {
      logger.info({ bot: BOT_NAME }, '✅ Bot is online and ready')
      // Send unavailable presence so WA delivers plaintext copies of our own messages
      // This is required for self-chat (fromMe) command processing to work
      await sock.sendPresenceUpdate('unavailable').catch(() => {})
      hydrateSchedules(sock)
      setupAutoUpdate(sock)
    }

    if (connection === 'close') {
      const boom = new Boom(lastDisconnect?.error)
      const statusCode = boom?.output?.statusCode
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0] ?? 'unknown'
      logger.warn({ code: statusCode, reason }, 'Connection closed')

      if (statusCode === DisconnectReason.loggedOut) {
        logger.warn('Session logged out (401). Clearing auth data. Restarting...')
        clearAuthDir()
        process.exit(2)
        return
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        logger.warn('Connection replaced by another session. Stopping.')
        process.exit(0)
        return
      }

      if (statusCode === DisconnectReason.restartRequired) {
        logger.info('Restart required after pairing. Restarting...')
        process.exit(2)
        return
      }

      // All other transient errors: reconnect in the same process
      logger.info('Reconnecting in 5s...')
      setTimeout(() => connect(), 5000)
    }
  })

  // ── Message handling ──────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        if (!msg.message) continue

        const chatJid = msg.key.remoteJid

        // Allow fromMe messages only in self-chat (owner messaging themselves).
        // Skip all other fromMe messages (bot's own replies to others).
        if (msg.key.fromMe) {
          const botJid = jidNormalizedUser(sock.user?.id || '')
          const chatUser = jidNormalizedUser(chatJid)
          const isSelfChat = botJid && chatUser === botJid
          logger.debug({ chatJid, botJid, chatUser, isSelfChat }, 'fromMe message check')
          if (!isSelfChat) continue
          // For self-chat, message content may not be decrypted yet.
          // Baileys will retry — but we can still read msg.message if available.
          if (!msg.message) continue
        }

        const senderJid = jidNormalizedUser(
          msg.key.fromMe
            ? (sock.user?.id || msg.key.remoteJid) // self-chat: sender is the owner/bot number
            : (msg.key.participant || chatJid)
        )
        const senderName = msg.pushName || senderJid.split('@')[0]
        const messageText = getMessageText(msg.message)

        if (!HIDE_READ_CHAT && chatJid !== 'status@broadcast') await sock.readMessages([msg.key])

        if (chatJid === 'status@broadcast') {
          await handleStatusMessage(sock, msg, senderJid, senderName, messageText)
          continue
        }

        trackMessageForDelete(msg, senderName)

        const viewOnce = extractViewOnce(msg.message)
        if (viewOnce) await handleAntiViewOnce(sock, msg, senderJid, senderName, viewOnce)

        const cmd = parseCommand(messageText)
        if (cmd) {
          logger.info({ senderJid, chatJid, cmd: cmd.command }, 'Command received')
          if (!isAuthorized(senderJid)) {
            logger.warn({ senderJid, authorized: AUTHORIZED_NUMBERS }, 'Unauthorized command attempt')
            await sock.sendMessage(chatJid, { text: t('unauthorized') }, { quoted: msg })
            continue
          }
          await handleCommand(sock, msg, cmd, senderJid)
          continue
        }

        await maybeAfkReply(sock, msg, senderJid)
        await maybeAutoRespond(sock, msg, messageText)
      } catch (error) {
        logger.error({ err: error }, 'Error handling incoming message')
      }
    }
  })

  sock.ev.on('messages.update', async (updates) => {
    const db = readDb()

    for (const update of updates) {
      if (update.update?.messageStubType !== 68 || !update.key?.id) continue
      const cached = db.deletedTracker[update.key.id]
      if (!cached) continue

      const details = `From: ${cached.sender}\nChat: ${update.key.remoteJid}\nMsgId: ${update.key.id}\nOriginal Time: ${cached.at}\nContent: ${cached.text || '_Media/empty_'}`
      await sock.sendMessage(update.key.remoteJid, { text: `🕵️ *Deleted message detected*\n${details}` })
      await forwardEventLog(sock, 'Deleted Message', details)
    }
  })
}

// ─── Message tracking ────────────────────────────────────────────────────────

function trackMessageForDelete(msg, senderName) {
  const db = readDb()
  db.deletedTracker[msg.key.id] = {
    sender: `${senderName} (${msg.key.participant || msg.key.remoteJid})`,
    text: getMessageText(msg.message),
    at: humanTs(msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
  }

  const entries = Object.entries(db.deletedTracker)
  if (entries.length > 3000) db.deletedTracker = Object.fromEntries(entries.slice(entries.length - 1500))
  writeDb(db)
}

// ─── Status / view-once / AFK / auto-respond ────────────────────────────────

async function handleStatusMessage(sock, msg, senderJid, senderName, text) {
  if (!HIDE_STATUS_VIEW) await sock.readMessages([msg.key])

  const stamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
  const prefix = `${senderJid.split('@')[0]}_${stamp}`
  let savedPath = ''

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    if (buffer?.length) {
      // Status media may be wrapped inside imageMessage, videoMessage, etc.
      const m = msg.message || {}
      const ext = (m.imageMessage || m.ephemeralMessage?.message?.imageMessage) ? 'jpg'
        : (m.videoMessage || m.ephemeralMessage?.message?.videoMessage) ? 'mp4'
        : (m.audioMessage || m.ephemeralMessage?.message?.audioMessage) ? 'ogg'
        : 'bin'
      savedPath = path.join(STATUS_DIR, `${prefix}.${ext}`)
      fs.writeFileSync(savedPath, buffer)
    }
  } catch (error) {
    logger.debug({ err: error }, 'No downloadable media in status')
  }

  const details = `From: ${senderName} (${senderJid})\nText: ${text || '_No text_'}\nSaved: ${savedPath || 'none'}\nTime: ${humanTs(stamp)}`
  await forwardEventLog(sock, 'Status Saved', details, createStatusDestinations())

  if (!savedPath) return
  const targets = createStatusDestinations()
  for (const jid of targets) {
    await safeSend(sock, jid, {
      document: fs.readFileSync(savedPath),
      fileName: path.basename(savedPath),
      mimetype: 'application/octet-stream',
      caption: `📥 Status from ${senderName}\n${humanTs(stamp)}`,
    })
  }
}

async function handleAntiViewOnce(sock, msg, senderJid, senderName, viewOnce) {
  const stamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
  const fileBase = `vo_${senderJid.split('@')[0]}_${stamp}`
  const targets = createViewOnceDestinations()
  const caption = `👁️ *Anti View-Once Captured*\nFrom: ${senderName} (${senderJid})\nType: ${viewOnce.type}\nTime: ${humanTs(stamp)}`

  for (const jid of targets) await safeSend(sock, jid, { text: caption })

  try {
    // Must pass a fake msg with the inner (unwrapped) message for downloadMediaMessage to work
    const innerMsg = { ...msg, message: viewOnce.inner }
    const buffer = await downloadMediaMessage(innerMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    if (!buffer?.length) return
    const ext = viewOnce.type === 'image' ? 'jpg' : viewOnce.type === 'video' ? 'mp4' : viewOnce.type === 'audio' ? 'ogg' : 'bin'
    const fullPath = path.join(STATUS_DIR, `${fileBase}.${ext}`)
    fs.writeFileSync(fullPath, buffer)

    for (const jid of targets) {
      await safeSend(sock, jid, {
        document: fs.readFileSync(fullPath),
        fileName: path.basename(fullPath),
        mimetype: 'application/octet-stream',
        caption,
      })
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed anti view-once media download')
  }
}

async function maybeAfkReply(sock, msg, senderJid) {
  if (isAuthorized(senderJid)) return
  const db = readDb()
  if (!db.afk?.enabled) return

  await sock.sendMessage(msg.key.remoteJid, { text: `🛌 AFK Notice\n${db.afk.message}\nSince: ${db.afk.since || 'unknown'}\nBy: ${db.afk.by || 'owner'}` }, { quoted: msg })
}

async function maybeAutoRespond(sock, msg, text) {
  if (!text) return
  const db = readDb()
  const lower = text.toLowerCase()
  for (const [keyword, response] of Object.entries(db.autoresponders)) {
    if (lower.includes(keyword.toLowerCase())) {
      await sock.sendMessage(msg.key.remoteJid, { text: `🤖 ${response}` }, { quoted: msg })
      return
    }
  }
}

// ─── Command router ───────────────────────────────────────────────────────────

async function handleCommand(sock, msg, cmd, senderJid) {
  const chatJid = msg.key.remoteJid
  const db = readDb()

  switch (cmd.command) {
    case 'help': {
      const helpText = [
        `*${BOT_NAME} Command Guide*`,
        BOT_LANG === 'id' ? '_Bahasa: Indonesia_' : '_Language: English_',
        '',
        `${PREFIX}help — command list + descriptions`,
        `${PREFIX}ping — health check`,
        `${PREFIX}whoami — your JID`,
        `${PREFIX}chatid — current chat JID`,
        `${PREFIX}uptime — bot uptime`,
        `${PREFIX}echo <text> — repeat text`,
        `${PREFIX}note add|list|find|del — manage notes`,
        `${PREFIX}todo add|done|list|del — manage tasks`,
        `${PREFIX}remind <time> <msg> — set reminder`,
        `${PREFIX}remind list|cancel <id> — reminder manager`,
        `${PREFIX}schedule text <time...> <jid|current> <msg> — schedule text`,
        `${PREFIX}schedule fwd <time...> <jid|current> — schedule replied media/message`,
        `${PREFIX}schedule list|cancel <id> — scheduler manager`,
        `${PREFIX}sticker — reply image to create sticker`,
        `${PREFIX}pair <number> — request MD pairing code for new device`,
        `${PREFIX}quote [add <text>] — quotes`,
        `${PREFIX}auto add|list|del — auto responder rules`,
        `${PREFIX}afk on <msg>|off|status — AFK mode`,
        `${PREFIX}stats — usage stats`,
      ].join('\n')
      await sock.sendMessage(chatJid, { text: helpText }, { quoted: msg })
      break
    }
    case 'ping':
      await sock.sendMessage(chatJid, { text: '🏓 pong' }, { quoted: msg })
      break
    case 'whoami':
      await sock.sendMessage(chatJid, { text: `You: ${senderJid}` }, { quoted: msg })
      break
    case 'chatid':
      await sock.sendMessage(chatJid, { text: `Chat ID: ${chatJid}` }, { quoted: msg })
      break
    case 'uptime':
      await sock.sendMessage(chatJid, { text: `⏱️ Uptime: ${formatDuration(Date.now() - startTime)}` }, { quoted: msg })
      break
    case 'echo':
      await sock.sendMessage(chatJid, { text: cmd.fullArgs || '_Nothing to echo._' }, { quoted: msg })
      break
    case 'note':
      await handleNote(sock, msg, cmd, db)
      break
    case 'todo':
      await handleTodo(sock, msg, cmd, db)
      break
    case 'auto':
      await handleAutoResponder(sock, msg, cmd, db)
      break
    case 'quote':
      await handleQuote(sock, msg, cmd, db)
      break
    case 'afk':
      await handleAfk(sock, msg, cmd, db, senderJid)
      break
    case 'remind':
      await handleReminder(sock, msg, cmd, senderJid)
      break
    case 'schedule':
      await handleScheduler(sock, msg, cmd, senderJid)
      break
    case 'sticker': {
      const { stickerBuffer, error } = await makeStickerFromQuoted(sock, msg)
      if (error) {
        await sock.sendMessage(chatJid, { text: error }, { quoted: msg })
        break
      }
      await sock.sendMessage(chatJid, { sticker: stickerBuffer }, { quoted: msg })
      break
    }
    case 'pair': {
      if (!ALLOW_PAIRING_COMMAND) {
        await sock.sendMessage(chatJid, { text: t('pairDisabled') }, { quoted: msg })
        break
      }
      const phone = (cmd.args[0] || '').replace(/\D/g, '')
      if (!phone) {
        await sock.sendMessage(chatJid, { text: t('pairUsage') }, { quoted: msg })
        break
      }
      try {
        const code = await sock.requestPairingCode(phone)
        await sock.sendMessage(chatJid, { text: `🔐 Pairing code for ${phone}: ${code}` }, { quoted: msg })
      } catch (error) {
        logger.warn({ err: error }, 'Pair command failed')
        await sock.sendMessage(chatJid, { text: t('pairFailed') }, { quoted: msg })
      }
      break
    }
    case 'stats': {
      const totalTodos = db.todos.length
      const completed = db.todos.filter((t) => t.done).length
      await sock.sendMessage(chatJid, {
        text:
          `📊 *Stats*\n` +
          `Notes: ${db.notes.length}\nTodos: ${totalTodos} (✅ ${completed} / 🕒 ${totalTodos - completed})\n` +
          `Auto rules: ${Object.keys(db.autoresponders).length}\nQuotes: ${db.quotes.length}\n` +
          `Reminders: ${reminderJobs.size}\nSchedules: ${readDb().schedules.length}\n` +
          `Authorized users: ${AUTHORIZED_NUMBERS.length || 'unrestricted'}\nAFK: ${db.afk?.enabled ? `on (${db.afk.since})` : 'off'}`,
      }, { quoted: msg })
      break
    }
    default:
      await sock.sendMessage(chatJid, { text: t('unknown') }, { quoted: msg })
  }
}

// ─── Feature handlers ─────────────────────────────────────────────────────────

async function handleReminder(sock, msg, cmd, senderJid) {
  const chatJid = msg.key.remoteJid
  const [sub, ...rest] = cmd.args

  if (sub === 'list') {
    const mine = Array.from(reminderMeta.values()).filter((r) => r.chatJid === chatJid)
    await sock.sendMessage(chatJid, { text: `⏰ *Active Reminders*\n${listItems(mine, (r) => `${r.id} • ${humanTs(r.runAt)} • ${r.message}`)}` }, { quoted: msg })
    return
  }

  if (sub === 'cancel') {
    const id = rest[0]
    if (!id || !reminderJobs.has(id)) {
      await sock.sendMessage(chatJid, { text: t('reminderNotFound') }, { quoted: msg })
      return
    }
    clearTimeout(reminderJobs.get(id))
    reminderJobs.delete(id)
    reminderMeta.delete(id)
    await sock.sendMessage(chatJid, { text: `🗑️ Reminder ${id} cancelled.` }, { quoted: msg })
    return
  }

  const parsed = parseReminderArgs(cmd.args)
  if (!parsed) {
    await sock.sendMessage(chatJid, { text: `${t('usageRemind')}\nExample: ${PREFIX}remind 1h 15m drink water\nExample: ${PREFIX}remind 11/03/2026 1h 15m pay bill` }, { quoted: msg })
    return
  }

  const id = `r-${Date.now().toString().slice(-6)}`
  const runAt = parsed.runAt
  const delay = Math.max(1000, runAt - Date.now())
  reminderMeta.set(id, { id, chatJid, message: parsed.message, runAt, by: senderJid })

  reminderJobs.set(id, setTimeout(async () => {
    await sock.sendMessage(chatJid, { text: `⏰ *Reminder*\n${parsed.message}\nSet by: ${senderJid.split('@')[0]}\nID: ${id}` })
    reminderJobs.delete(id)
    reminderMeta.delete(id)
  }, delay))

  await sock.sendMessage(chatJid, { text: `✅ Reminder (${id}) set for ${humanTs(runAt)}` }, { quoted: msg })
}

async function handleScheduler(sock, msg, cmd, senderJid) {
  const chatJid = msg.key.remoteJid
  const [sub, ...rest] = cmd.args

  if (sub === 'list') {
    const db = readDb()
    const rows = db.schedules.filter((s) => s.by === senderJid)
    const out = listItems(rows, (s) => `${s.id} • ${s.type} • ${s.targetJid} • ${humanTs(s.runAt)}`)
    await sock.sendMessage(chatJid, { text: `🗓️ *Scheduled Messages*\n${out}` }, { quoted: msg })
    return
  }

  if (sub === 'cancel') {
    const id = rest[0]
    const db = readDb()
    const found = db.schedules.find((s) => s.id === id)
    if (!id || !found) {
      await sock.sendMessage(chatJid, { text: t('scheduleNotFound') }, { quoted: msg })
      return
    }
    if (scheduleJobs.has(id)) {
      clearTimeout(scheduleJobs.get(id))
      scheduleJobs.delete(id)
    }
    db.schedules = db.schedules.filter((s) => s.id !== id)
    writeDb(db)
    await sock.sendMessage(chatJid, { text: `🗑️ Schedule ${id} cancelled.` }, { quoted: msg })
    return
  }

  if (sub === 'text') {
    const plan = parsePlanningTokens(rest, 0)
    const targetJid = parseTargetJid(rest[plan?.consumed || 0], chatJid)
    const text = rest.slice((plan?.consumed || 0) + 1).join(' ').trim()
    if (!plan || !text) {
      await sock.sendMessage(chatJid, { text: `${t('usageScheduleText')}\nExample: ${PREFIX}schedule text 1h 15m current hello\nExample: ${PREFIX}schedule text 11/03/2026 1h 15m 62812xxxx reminder` }, { quoted: msg })
      return
    }

    const id = `s-${Date.now().toString().slice(-7)}`
    const runAt = plan.runAt
    const item = { id, type: 'text', targetJid, text, by: senderJid, runAt, createdAt: nowTs() }
    const db = readDb()
    db.schedules.push(item)
    writeDb(db)
    registerScheduleJob(sock, item)

    await sock.sendMessage(chatJid, { text: `✅ Schedule (${id}) text to ${targetJid} at ${humanTs(runAt)}` }, { quoted: msg })
    return
  }

  if (sub === 'fwd') {
    const plan = parsePlanningTokens(rest, 0)
    const targetJid = parseTargetJid(rest[plan?.consumed || 0], chatJid)
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (!plan || !quoted) {
      await sock.sendMessage(chatJid, { text: `${t('usageScheduleFwd')}\nExample: reply then ${PREFIX}schedule fwd 1h 15m current` }, { quoted: msg })
      return
    }

    const id = `s-${Date.now().toString().slice(-7)}`
    const runAt = plan.runAt
    const item = { id, type: 'fwd', targetJid, quotedMessage: quoted, by: senderJid, runAt, createdAt: nowTs() }
    const db = readDb()
    db.schedules.push(item)
    writeDb(db)
    registerScheduleJob(sock, item)

    await sock.sendMessage(chatJid, { text: `✅ Schedule (${id}) forwarded message to ${targetJid} at ${humanTs(runAt)}` }, { quoted: msg })
    return
  }

  await sock.sendMessage(
    chatJid,
    { text: `${t('usageScheduleText')}\n${t('usageScheduleFwd')}\n${PREFIX}schedule list\n${PREFIX}schedule cancel <id>` },
    { quoted: msg }
  )
}

async function handleAfk(sock, msg, cmd, db, senderJid) {
  const chatJid = msg.key.remoteJid
  const [sub, ...rest] = cmd.args

  if (sub === 'on') {
    const message = rest.join(' ').trim() || 'I am currently AFK. I will reply later.'
    db.afk = { enabled: true, message, since: humanTs(), by: senderJid }
    writeDb(db)
    await sock.sendMessage(chatJid, { text: t('afkOn') }, { quoted: msg })
    return
  }

  if (sub === 'off') {
    db.afk = { enabled: false, message: 'I am currently AFK.', since: null, by: senderJid }
    writeDb(db)
    await sock.sendMessage(chatJid, { text: t('afkOff') }, { quoted: msg })
    return
  }

  if (sub === 'status') {
    await sock.sendMessage(chatJid, { text: db.afk?.enabled ? `🛌 AFK is ON\nMessage: ${db.afk.message}\nSince: ${db.afk.since}\nBy: ${db.afk.by}` : '🟢 AFK is OFF' }, { quoted: msg })
    return
  }

  await sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}afk on <msg> | ${PREFIX}afk off | ${PREFIX}afk status` }, { quoted: msg })
}

async function handleNote(sock, msg, cmd, db) {
  const [sub, ...rest] = cmd.args
  const chatJid = msg.key.remoteJid

  if (sub === 'add') {
    const text = rest.join(' ').trim()
    if (!text) return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}note add buy groceries` }, { quoted: msg })
    const id = db.notes.length ? db.notes.at(-1).id + 1 : 1
    db.notes.push({ id, text, at: nowTs() })
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `📝 Saved note #${id}` }, { quoted: msg })
  }

  if (sub === 'list') return sock.sendMessage(chatJid, { text: `🗒️ *Notes*\n${listItems(db.notes, (n) => `#${n.id} • ${n.text}`)}` }, { quoted: msg })

  if (sub === 'find') {
    const keyword = rest.join(' ').trim().toLowerCase()
    if (!keyword) return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}note find grocery` }, { quoted: msg })
    const rows = db.notes.filter((n) => n.text.toLowerCase().includes(keyword))
    return sock.sendMessage(chatJid, { text: `🔎 *Note Search*\n${listItems(rows, (n) => `#${n.id} • ${n.text}`)}` }, { quoted: msg })
  }

  if (sub === 'del') {
    const id = Number(rest[0])
    const next = db.notes.filter((n) => n.id !== id)
    if (next.length === db.notes.length) return sock.sendMessage(chatJid, { text: t('noteNotFound') }, { quoted: msg })
    db.notes = next
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `🗑️ Deleted note #${id}` }, { quoted: msg })
  }

  return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}note add|list|find|del` }, { quoted: msg })
}

async function handleTodo(sock, msg, cmd, db) {
  const [sub, ...rest] = cmd.args
  const chatJid = msg.key.remoteJid
  if (sub === 'add') {
    const text = rest.join(' ').trim()
    if (!text) return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}todo add pay cloud bill` }, { quoted: msg })
    const id = db.todos.length ? db.todos.at(-1).id + 1 : 1
    db.todos.push({ id, text, done: false, at: nowTs() })
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `✅ Task #${id} added` }, { quoted: msg })
  }
  if (sub === 'done') {
    const found = db.todos.find((t) => t.id === Number(rest[0]))
    if (!found) return sock.sendMessage(chatJid, { text: t('todoNotFound') }, { quoted: msg })
    found.done = true
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `🎉 Task #${found.id} marked done` }, { quoted: msg })
  }
  if (sub === 'list') return sock.sendMessage(chatJid, { text: `📌 *Todos*\n${listItems(db.todos, (t) => `${t.done ? '✅' : '🕒'} #${t.id} • ${t.text}`)}` }, { quoted: msg })
  if (sub === 'del') {
    const id = Number(rest[0])
    const next = db.todos.filter((t) => t.id !== id)
    if (next.length === db.todos.length) return sock.sendMessage(chatJid, { text: t('todoNotFound') }, { quoted: msg })
    db.todos = next
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `🗑️ Task #${id} deleted` }, { quoted: msg })
  }
  return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}todo add|done|list|del` }, { quoted: msg })
}

async function handleAutoResponder(sock, msg, cmd, db) {
  const [sub, ...rest] = cmd.args
  const chatJid = msg.key.remoteJid
  if (sub === 'add') {
    const [keyword, response] = rest.join(' ').split('|').map((x) => x?.trim())
    if (!keyword || !response) return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}auto add keyword | reply` }, { quoted: msg })
    db.autoresponders[keyword] = response
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `🤖 Auto responder saved for "${keyword}"` }, { quoted: msg })
  }
  if (sub === 'list') {
    const rows = Object.entries(db.autoresponders)
    const out = rows.length ? rows.map(([k, v]) => `• ${k} → ${v}`).join('\n') : '_No auto responders configured._'
    return sock.sendMessage(chatJid, { text: `⚙️ *Auto Responders*\n${out}` }, { quoted: msg })
  }
  if (sub === 'del') {
    const keyword = rest.join(' ').trim()
    if (!keyword || !db.autoresponders[keyword]) return sock.sendMessage(chatJid, { text: t('keywordNotFound') }, { quoted: msg })
    delete db.autoresponders[keyword]
    writeDb(db)
    return sock.sendMessage(chatJid, { text: `🗑️ Removed auto responder for "${keyword}"` }, { quoted: msg })
  }
  return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}auto add|list|del` }, { quoted: msg })
}

async function handleQuote(sock, msg, cmd, db) {
  const [sub, ...rest] = cmd.args
  const chatJid = msg.key.remoteJid
  if (sub === 'add') {
    const quote = rest.join(' ').trim()
    if (!quote) return sock.sendMessage(chatJid, { text: `Usage: ${PREFIX}quote add your quote` }, { quoted: msg })
    db.quotes.push(quote)
    writeDb(db)
    return sock.sendMessage(chatJid, { text: '✨ Quote added.' }, { quoted: msg })
  }
  const picked = db.quotes[Math.floor(Math.random() * db.quotes.length)] || 'No quote found.'
  return sock.sendMessage(chatJid, { text: `💡 ${picked}` }, { quoted: msg })
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// connect() uses process.exit(2) to signal "restart needed" (after 401 / restartRequired).
// This loop catches that and re-runs connect() in the same process, giving a clean
// fresh auth state each time without leaking old socket event listeners.

async function main() {
  while (true) {
    const exitCode = await new Promise((resolve) => {
      // Override process.exit so we can catch it instead of actually exiting
      // when called from within connect()'s event handlers.
      const origExit = process.exit.bind(process)
      process.exit = (code) => {
        process.exit = origExit // restore
        resolve(code ?? 0)
      }
      connect().catch((err) => {
        process.exit = process.exit.bind(process) // restore if connect() throws before exit
        logger.error({ err }, 'Fatal connect() error')
        resolve(1)
      })
    })

    if (exitCode === 2) {
      logger.info('Restarting bot in 4s...')
      await waitMs(4000)
      continue
    }

    // exit code 0 or 1 = done, actually exit
    process.exit(exitCode)
  }
}

main()
