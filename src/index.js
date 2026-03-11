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

const logger = P({ level: process.env.LOG_LEVEL || 'info' })
const startTime = Date.now()

const BOT_NAME = process.env.BOT_NAME || 'PersonalBot'
const PREFIX = process.env.BOT_PREFIX || '!'
const BOT_LANG = (process.env.BOT_LANG || 'en').toLowerCase()
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || 'data/auth')
const DB_FILE = path.resolve(process.env.DB_FILE || 'data/store.json')
const STATUS_DIR = path.resolve(process.env.STATUS_DIR || 'data/status')
const HIDE_ONLINE = toBool(process.env.HIDE_ONLINE, true)
const HIDE_READ_CHAT = toBool(process.env.HIDE_READ_CHAT, true)
const HIDE_STATUS_VIEW = toBool(process.env.HIDE_STATUS_VIEW, true)
const FORWARD_EVENTS_TO_OWNER = toBool(process.env.FORWARD_EVENTS_TO_OWNER, true)
const FORWARD_EVENTS_TO_AUTH_USERS = toBool(process.env.FORWARD_EVENTS_TO_AUTH_USERS, false)

const OWNER_NUMBERS = parseNumbers(process.env.OWNER_NUMBERS)
const AUTHORIZED_NUMBERS = Array.from(new Set([...OWNER_NUMBERS, ...parseNumbers(process.env.AUTHORIZED_NUMBERS)]))
const EVENT_FORWARD_JIDS = parseJids(process.env.EVENT_FORWARD_JIDS)
const VIEW_ONCE_FORWARD_JIDS = parseJids(process.env.VIEW_ONCE_FORWARD_JIDS)
const STATUS_FORWARD_JIDS = parseJids(process.env.STATUS_FORWARD_JIDS)

const reminderJobs = new Map()
const reminderMeta = new Map()
const scheduleJobs = new Map()

ensureJsonDb()
ensureDir(STATUS_DIR)

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
    },
  }
  const lang = dict[BOT_LANG] ? BOT_LANG : 'en'
  let msg = dict[lang][key] || dict.en[key] || key
  for (const [k, v] of Object.entries(vars)) msg = msg.replaceAll(`{${k}}`, String(v))
  return msg
}

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

function nowTs() {
  return new Date().toISOString()
}

function humanTs(ts = Date.now()) {
  return new Date(ts).toLocaleString()
}

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

function parseDelay(input) {
  const match = input.match(/^(\d+)([mhd])$/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const multipliers = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  const delay = amount * multipliers[unit]
  if (delay < 10_000 || delay > 30 * 86_400_000) return null
  return delay
}

function parseReminder(input) {
  const [delayRaw, ...msgParts] = input.split(' ')
  const delay = parseDelay(delayRaw)
  if (!delay || msgParts.length === 0) return null
  return { delay, message: msgParts.join(' ') }
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
  if (inner.imageMessage) return { type: 'image' }
  if (inner.videoMessage) return { type: 'video' }
  if (inner.audioMessage) return { type: 'audio' }
  if (inner.documentMessage) return { type: 'document' }
  return { type: 'unknown' }
}

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

async function connect() {
  ensureDir(AUTH_DIR)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger,
    browser: ['Ubuntu', 'Chrome', '22.04'],
    markOnlineOnConnect: !HIDE_ONLINE,
  })

  hydrateSchedules(sock)
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue

        const chatJid = msg.key.remoteJid
        const senderJid = jidNormalizedUser(msg.key.participant || chatJid)
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
          if (!isAuthorized(senderJid)) {
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

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') logger.info(`${BOT_NAME} online`)
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ code, shouldReconnect }, 'Connection closed')
      if (shouldReconnect) connect()
    }
  })
}

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

async function handleStatusMessage(sock, msg, senderJid, senderName, text) {
  if (!HIDE_STATUS_VIEW) await sock.readMessages([msg.key])

  const stamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
  const prefix = `${senderJid.split('@')[0]}_${stamp}`
  let savedPath = ''

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    if (buffer?.length) {
      const ext = msg.message?.imageMessage ? 'jpg' : msg.message?.videoMessage ? 'mp4' : msg.message?.audioMessage ? 'ogg' : 'bin'
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
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
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
        `${PREFIX}schedule text <time> <jid|current> <msg> — schedule text`,
        `${PREFIX}schedule fwd <time> <jid|current> — schedule replied media/message`,
        `${PREFIX}schedule list|cancel <id> — scheduler manager`,
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

  const parsed = parseReminder(cmd.fullArgs)
  if (!parsed) {
    await sock.sendMessage(chatJid, { text: t('usageRemind') }, { quoted: msg })
    return
  }

  const id = `r-${Date.now().toString().slice(-6)}`
  const runAt = Date.now() + parsed.delay
  reminderMeta.set(id, { id, chatJid, message: parsed.message, runAt, by: senderJid })

  reminderJobs.set(id, setTimeout(async () => {
    await sock.sendMessage(chatJid, { text: `⏰ *Reminder*\n${parsed.message}\nSet by: ${senderJid.split('@')[0]}\nID: ${id}` })
    reminderJobs.delete(id)
    reminderMeta.delete(id)
  }, parsed.delay))

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
    const delay = parseDelay(rest[0] || '')
    const targetJid = parseTargetJid(rest[1], chatJid)
    const text = rest.slice(2).join(' ').trim()
    if (!delay || !text) {
      await sock.sendMessage(chatJid, { text: t('usageScheduleText') }, { quoted: msg })
      return
    }

    const id = `s-${Date.now().toString().slice(-7)}`
    const runAt = Date.now() + delay
    const item = { id, type: 'text', targetJid, text, by: senderJid, runAt, createdAt: nowTs() }
    const db = readDb()
    db.schedules.push(item)
    writeDb(db)
    registerScheduleJob(sock, item)

    await sock.sendMessage(chatJid, { text: `✅ Schedule (${id}) text to ${targetJid} at ${humanTs(runAt)}` }, { quoted: msg })
    return
  }

  if (sub === 'fwd') {
    const delay = parseDelay(rest[0] || '')
    const targetJid = parseTargetJid(rest[1], chatJid)
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (!delay || !quoted) {
      await sock.sendMessage(chatJid, { text: t('usageScheduleFwd') }, { quoted: msg })
      return
    }

    const id = `s-${Date.now().toString().slice(-7)}`
    const runAt = Date.now() + delay
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

connect().catch((error) => {
  logger.error({ err: error }, 'Fatal start error')
  process.exit(1)
})
