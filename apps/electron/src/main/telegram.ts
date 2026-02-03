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

interface SessionResult {
  session: ChatSession
  isNew: boolean
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
  private workspaceRootPath: string
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
  private telegramContextDir: string

  constructor(sessionManager: SessionManager, workspaceRootPath: string) {
    this.sessionManager = sessionManager
    this.workspaceRootPath = workspaceRootPath
    this.mappingFilePath = join(workspaceRootPath, 'telegram-sessions.json')
    this.telegramContextDir = join(workspaceRootPath, 'telegram')
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
      const { session, isNew } = await this.getOrCreateSession(chatId)

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

      // On first message of a new session, prepend identity context directly
      // into the message (project context files are only listed as paths in
      // the system prompt and not inlined, so the agent won't read them
      // automatically on the first turn)
      const messageToSend = isNew ? this.buildFirstMessage(text, chatId, senderName) : text

      // Send message through the full agent pipeline
      await this.sessionManager.sendMessage(session.sessionId, messageToSend)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      telegramLog.error(`Error handling message from chat ${chatId}:`, message)
      await this.sendTelegramMessage(chatId, `Error: ${message}`)
    }
  }

  private buildFirstMessage(text: string, chatId: number, senderName?: string): string {
    const botUsername = this.status.botUsername ?? 'craft_agents_bot'
    return `[TELEGRAM AGENT ORCHESTRATOR CONTEXT — read this before responding]

You are @${botUsername}, the **Telegram Agent Orchestrator** for this Craft Agents workspace.
This message comes from Telegram chat ${chatId}${senderName ? ` (${senderName})` : ''}.

## Your Role
You are the controller agent. You can:
1. **Spawn worker agents** - Create new sessions for specific tasks
2. **Monitor sessions** - Check on running agents, see their progress
3. **Communicate with agents** - Send messages and get responses
4. **Manage sessions** - Stop, delete, rename, or label sessions

## Session Control Tools (session-control MCP)
You have these tools available:
- \`list_sessions\` - List all sessions with status
- \`create_session\` - Create a worker session (optionally with initialMessage)
- \`send_message\` - Send to a session. Use \`waitForResponse: true\` to get the result
- \`get_session_status\` - Get detailed status (tokens, message count)
- \`get_session_messages\` - Retrieve conversation history
- \`stop_session\` - Cancel processing
- \`delete_session\` - Delete a session
- \`rename_session\` / \`set_session_labels\` - Organize sessions

## Quick Patterns
- **Quick task:** create_session → send_message(waitForResponse:true) → return result
- **Long task:** create_session with labels → send_message → tell user to check back
- **Parallel:** create multiple sessions, send to all, check progress with list_sessions

## Communication
- Keep responses concise (Telegram chat bubbles)
- When delegating, tell the user what you're doing
- For long tasks, give them the session ID to check back

Permission mode: allow-all. You have full access to tools, sources, MCP servers, and bash.
[END CONTEXT]

${text}`
  }

  private async getOrCreateSession(chatId: number): Promise<SessionResult> {
    const existing = this.chatSessions.get(chatId)
    if (existing) {
      // Verify the session still exists (user may have deleted it)
      const session = await this.sessionManager.getSession(existing.sessionId)
      if (session) {
        return { session: existing, isNew: false }
      }
      // Session was deleted — remove stale mapping and create a fresh one
      telegramLog.info(`Session ${existing.sessionId} for chat ${chatId} was deleted, creating new session`)
      this.chatSessions.delete(chatId)
      this.eventUnsubscribers.get(existing.sessionId)?.()
      this.eventUnsubscribers.delete(existing.sessionId)
      this.streamingStates.delete(existing.sessionId)
    }

    // Write CLAUDE.md to shared telegram dir BEFORE session creation
    // so the agent discovers it during initialization (timing matters!)
    this.ensureTelegramContext(chatId)

    // Create session with workingDirectory pointing to the telegram context dir
    const { getActiveWorkspace } = await import('@craft-agent/shared/config')
    const workspace = getActiveWorkspace()
    if (!workspace) {
      throw new Error('No active workspace found')
    }

    const session = await this.sessionManager.createSession(workspace.id, {
      permissionMode: 'allow-all',
      workingDirectory: this.telegramContextDir,
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
    return { session: chatSession, isNew: true }
  }

  private ensureTelegramContext(chatId: number): void {
    if (!existsSync(this.telegramContextDir)) {
      mkdirSync(this.telegramContextDir, { recursive: true })
    }

    const claudeMdPath = join(this.telegramContextDir, 'CLAUDE.md')
    const botUsername = this.status.botUsername ?? 'craft_agents_bot'

    const content = `# Telegram Agent Orchestrator

You are the **Telegram Agent Orchestrator** (\`@${botUsername}\`).
Messages you receive come from Telegram chat \`${chatId}\`.

## Your Role

You are the **controller agent** for this Craft Agents workspace. You can:
1. **Spawn worker agents** - Create new sessions for specific tasks
2. **Monitor sessions** - Check on running agents, see their progress
3. **Communicate with agents** - Send messages and get responses
4. **Manage sessions** - Stop, delete, rename, or label sessions

## Session Control Tools

You have access to the \`session-control\` MCP server with these tools:

| Tool | Description |
|------|-------------|
| \`list_sessions\` | List all sessions with status (processing/idle, labels, token usage) |
| \`create_session\` | Create a new worker session, optionally send initial message |
| \`send_message\` | Send a message to a session. Use \`waitForResponse: true\` to get the result |
| \`get_session_status\` | Get detailed status (token usage, message count, etc.) |
| \`get_session_messages\` | Retrieve conversation history from a session |
| \`stop_session\` | Cancel processing in a session |
| \`delete_session\` | Delete a session and all its data |
| \`rename_session\` | Set a custom name for a session |
| \`set_session_labels\` | Add/remove labels from a session |

## Orchestration Patterns

### Pattern 1: Quick Task Delegation
\`\`\`
1. create_session with initialMessage
2. send_message with waitForResponse: true
3. Return result to Telegram user
4. Optionally delete_session when done
\`\`\`

### Pattern 2: Long-Running Worker
\`\`\`
1. create_session with labels: ["worker", "task-type"]
2. send_message (fire-and-forget)
3. User can check back later
4. You report progress via get_session_status
\`\`\`

### Pattern 3: Parallel Workers
\`\`\`
1. create_session for task A
2. create_session for task B
3. send_message to both (don't wait)
4. Check progress with list_sessions
5. Collect results when both complete
\`\`\`

## Communication Style

- Keep responses concise — they appear in Telegram chat bubbles
- Avoid very long code blocks when possible (use summaries)
- Use plain text or minimal markdown (Telegram supports limited formatting)
- When delegating to workers, tell the user what you're doing
- For long tasks, tell the user you'll start a worker and they can check back

## Examples

**User:** "Find all TODO comments in the craft-agents codebase"
**You:** Create a worker session, send it the task, wait for response, return summary

**User:** "Start a code review for this PR"
**You:** Create a worker with the review task, tell user the session ID, they can check back

**User:** "What are my agents working on?"
**You:** Use list_sessions to show active sessions and their status

## Your Identity

- You are the Telegram Agent Orchestrator for this workspace
- This session is persistent — the same Telegram chat always maps to this session
- You have **full access** to all tools, sources, MCP servers, and bash
- Permission mode: \`allow-all\` (no confirmation needed for any action)
- You are labeled as \`telegram\` which gives you the session-control tools
`

    try {
      writeFileSync(claudeMdPath, content, 'utf-8')
      telegramLog.info(`Wrote Telegram CLAUDE.md to ${this.telegramContextDir}`)
    } catch (err) {
      telegramLog.warn(`Failed to write Telegram CLAUDE.md:`, err)
    }
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
