/**
 * TelegramService — Native Telegram bot integration for Craft Agents
 *
 * Runs in the Electron main process using grammY (long polling).
 * Incoming Telegram messages trigger full agent sessions with all tools,
 * sources, and MCP servers via SessionManager.
 *
 * Architecture:
 *   Telegram API ←→ grammY (long polling) ←→ TelegramService ←→ SessionManager.sendMessage()
 *   Response: SessionManager events → formatForTelegram() → bot.api.sendMessage()
 */

import { Bot } from 'grammy'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import log from './logger'
import type { SessionManager } from './sessions'
import type { SessionEvent } from '../shared/types'

const telegramLog = log.scope('telegram')

// Telegram message length limit
const TELEGRAM_MESSAGE_LIMIT = 4096

// How often to edit the "streaming" message (ms)
const STREAM_EDIT_INTERVAL = 800

// Maximum edits per message to avoid rate limits
const MAX_EDITS_PER_MESSAGE = 30

export interface TelegramStatus {
  running: boolean
  botUsername: string | null
  hasToken: boolean
  error: string | null
}

interface ChatSession {
  chatId: number
  sessionId: string
  workspaceId: string
}

interface StreamingState {
  chatId: number
  messageId: number | null  // Telegram message ID being edited
  buffer: string
  editCount: number
  editTimer: ReturnType<typeof setTimeout> | null
  complete: boolean
}

export class TelegramService {
  private bot: Bot | null = null
  private sessionManager: SessionManager
  private chatSessions: Map<number, ChatSession> = new Map()  // chatId → session info
  private streamingStates: Map<string, StreamingState> = new Map()  // sessionId → streaming state
  private eventUnsubscribers: Map<string, () => void> = new Map()  // sessionId → unsubscribe fn
  private status: TelegramStatus = {
    running: false,
    botUsername: null,
    hasToken: false,
    error: null,
  }
  private mappingFilePath: string

  constructor(sessionManager: SessionManager, workspaceRootPath: string) {
    this.sessionManager = sessionManager
    this.mappingFilePath = join(workspaceRootPath, 'telegram-sessions.json')
    this.loadChatSessions()
  }

  async start(token: string): Promise<TelegramStatus> {
    if (this.bot) {
      await this.stop()
    }

    this.status.hasToken = true
    this.status.error = null

    try {
      this.bot = new Bot(token)

      // Register message handler
      this.bot.on('message:text', async (ctx) => {
        await this.handleMessage(ctx.chat.id, ctx.message.text, ctx.from?.first_name)
      })

      // Handle errors gracefully
      this.bot.catch((err) => {
        telegramLog.error('Bot error:', err.message)
        this.status.error = err.message
      })

      // Get bot info (validates token)
      const me = await this.bot.api.getMe()
      this.status.botUsername = me.username ?? null
      telegramLog.info(`Bot authenticated as @${me.username}`)

      // Start long polling (non-blocking)
      this.bot.start({
        onStart: () => {
          this.status.running = true
          this.status.error = null
          telegramLog.info('Telegram bot started (long polling)')
        },
      })

      this.status.running = true
      return this.getStatus()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      telegramLog.error('Failed to start Telegram bot:', message)
      this.status.error = message
      this.status.running = false
      this.bot = null
      return this.getStatus()
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }

    // Clean up all event subscriptions
    for (const unsub of this.eventUnsubscribers.values()) {
      unsub()
    }
    this.eventUnsubscribers.clear()

    // Clear streaming states
    for (const state of this.streamingStates.values()) {
      if (state.editTimer) clearTimeout(state.editTimer)
    }
    this.streamingStates.clear()

    this.status.running = false
    this.status.error = null
    telegramLog.info('Telegram bot stopped')
  }

  getStatus(): TelegramStatus {
    return { ...this.status }
  }

  // ─── Message Handling ───────────────────────────────────────────────

  private async handleMessage(chatId: number, text: string, senderName?: string): Promise<void> {
    telegramLog.info(`Message from chat ${chatId}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`)

    try {
      const session = await this.getOrCreateSession(chatId)

      // Set up event listener for this session if not already listening
      this.ensureEventListener(session.sessionId, chatId)

      // Initialize streaming state
      this.streamingStates.set(session.sessionId, {
        chatId,
        messageId: null,
        buffer: '',
        editCount: 0,
        editTimer: null,
        complete: false,
      })

      // Send "thinking" indicator
      await this.bot?.api.sendChatAction(chatId, 'typing')

      // Send message through the full agent pipeline
      await this.sessionManager.sendMessage(session.sessionId, text)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      telegramLog.error(`Error handling message from chat ${chatId}:`, message)
      await this.sendTelegramMessage(chatId, `Error: ${message}`)
    }
  }

  private async getOrCreateSession(chatId: number): Promise<ChatSession> {
    const existing = this.chatSessions.get(chatId)
    if (existing) {
      return existing
    }

    // Create a new Craft Agent session for this Telegram chat
    const { getActiveWorkspace } = await import('@craft-agent/shared/config')
    const workspace = getActiveWorkspace()
    if (!workspace) {
      throw new Error('No active workspace found')
    }

    const session = await this.sessionManager.createSession(workspace.id, {
      permissionMode: 'allow-all',
      workingDirectory: 'user_default',
    })

    const chatSession: ChatSession = {
      chatId,
      sessionId: session.id,
      workspaceId: workspace.id,
    }

    this.chatSessions.set(chatId, chatSession)
    this.saveChatSessions()

    // Label the session as Telegram
    this.sessionManager.setSessionLabels(session.id, ['telegram'])

    telegramLog.info(`Created session ${session.id} for Telegram chat ${chatId}`)
    return chatSession
  }

  // ─── Event Bridging (Session Events → Telegram) ─────────────────────

  private ensureEventListener(sessionId: string, chatId: number): void {
    if (this.eventUnsubscribers.has(sessionId)) return

    const unsubscribe = this.sessionManager.onSessionEvent(sessionId, (event: SessionEvent) => {
      this.handleSessionEvent(sessionId, chatId, event)
    })

    this.eventUnsubscribers.set(sessionId, unsubscribe)
  }

  private handleSessionEvent(sessionId: string, chatId: number, event: SessionEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.handleTextDelta(sessionId, chatId, event.delta)
        break

      case 'text_complete':
        if (!event.isIntermediate) {
          this.handleTextComplete(sessionId, chatId, event.text)
        }
        break

      case 'complete':
        this.handleComplete(sessionId, chatId)
        break

      case 'error':
        this.sendTelegramMessage(chatId, `Error: ${event.error}`)
        break

      case 'typed_error':
        this.sendTelegramMessage(chatId, `Error: ${event.error.message}`)
        break
    }
  }

  private handleTextDelta(sessionId: string, chatId: number, delta: string): void {
    const state = this.streamingStates.get(sessionId)
    if (!state) return

    state.buffer += delta

    // Schedule an edit if we haven't already
    if (!state.editTimer && state.editCount < MAX_EDITS_PER_MESSAGE) {
      state.editTimer = setTimeout(() => {
        state.editTimer = null
        this.flushStreamingBuffer(sessionId, chatId)
      }, STREAM_EDIT_INTERVAL)
    }
  }

  private async flushStreamingBuffer(sessionId: string, chatId: number): Promise<void> {
    const state = this.streamingStates.get(sessionId)
    if (!state || !state.buffer) return

    const text = truncateForTelegram(state.buffer)

    try {
      if (!state.messageId) {
        // First message — send new
        const sent = await this.bot?.api.sendMessage(chatId, text)
        if (sent) state.messageId = sent.message_id
      } else if (state.editCount < MAX_EDITS_PER_MESSAGE) {
        // Edit existing message with accumulated text
        await this.bot?.api.editMessageText(chatId, state.messageId, text)
      }
      state.editCount++
    } catch (err: unknown) {
      // editMessageText fails if text hasn't changed — ignore
      const msg = err instanceof Error ? err.message : ''
      if (!msg.includes('message is not modified')) {
        telegramLog.warn(`Failed to update streaming message:`, msg)
      }
    }
  }

  private async handleTextComplete(sessionId: string, chatId: number, text: string): Promise<void> {
    const state = this.streamingStates.get(sessionId)
    if (!state) return

    // Clear any pending edit timer
    if (state.editTimer) {
      clearTimeout(state.editTimer)
      state.editTimer = null
    }

    // Send the final complete text
    const messages = splitMessage(text)
    for (const msg of messages) {
      try {
        if (state.messageId && messages.indexOf(msg) === 0) {
          // Edit the streaming message with final text
          await this.bot?.api.editMessageText(chatId, state.messageId, msg)
        } else {
          // Send additional messages for overflow
          await this.bot?.api.sendMessage(chatId, msg)
        }
      } catch {
        // If edit fails, send as new message
        await this.sendTelegramMessage(chatId, msg)
      }
    }

    // Reset streaming state for next response
    state.messageId = null
    state.buffer = ''
    state.editCount = 0
  }

  private handleComplete(sessionId: string, _chatId: number): void {
    const state = this.streamingStates.get(sessionId)
    if (!state) return

    // Clear any pending edit timer
    if (state.editTimer) {
      clearTimeout(state.editTimer)
      state.editTimer = null
    }

    state.complete = true
    this.streamingStates.delete(sessionId)
  }

  // ─── Telegram Messaging ─────────────────────────────────────────────

  private async sendTelegramMessage(chatId: number, text: string): Promise<void> {
    if (!this.bot) return

    const messages = splitMessage(text)
    for (const msg of messages) {
      try {
        await this.bot.api.sendMessage(chatId, msg)
      } catch (err: unknown) {
        telegramLog.error(`Failed to send message to chat ${chatId}:`, err)
      }
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────

  private loadChatSessions(): void {
    try {
      if (existsSync(this.mappingFilePath)) {
        const data = JSON.parse(readFileSync(this.mappingFilePath, 'utf-8'))
        if (Array.isArray(data)) {
          for (const entry of data) {
            this.chatSessions.set(entry.chatId, entry)
          }
        }
        telegramLog.info(`Loaded ${this.chatSessions.size} Telegram chat sessions`)
      }
    } catch (err) {
      telegramLog.warn('Failed to load Telegram chat sessions:', err)
    }
  }

  private saveChatSessions(): void {
    try {
      const dir = join(this.mappingFilePath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = Array.from(this.chatSessions.values())
      writeFileSync(this.mappingFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      telegramLog.warn('Failed to save Telegram chat sessions:', err)
    }
  }
}

// ─── Formatting Utilities ───────────────────────────────────────────────

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text
  return text.slice(0, TELEGRAM_MESSAGE_LIMIT - 3) + '...'
}

export function splitMessage(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text]

  const messages: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      messages.push(remaining)
      break
    }

    // Try to split on paragraph boundary
    let splitAt = remaining.lastIndexOf('\n\n', limit)
    if (splitAt <= 0) {
      // Try single newline
      splitAt = remaining.lastIndexOf('\n', limit)
    }
    if (splitAt <= 0) {
      // Try space
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt <= 0) {
      // Hard split
      splitAt = limit
    }

    messages.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return messages
}
