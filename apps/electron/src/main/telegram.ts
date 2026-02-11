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

  /**
   * Clear token status (called after token is deleted from storage)
   */
  clearTokenStatus(): void {
    this.status.hasToken = false
    this.status.botUsername = null
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
    return `[ORCHESTRATOR INIT — Chat ${chatId}${senderName ? ` (${senderName})` : ''}]

You are @${botUsername}, an autonomous agent orchestrator. Read your CLAUDE.md for full instructions.

**Startup checklist:**
1. Read memory file if exists (check session state for path)
2. Check list_sessions for any active tasks from previous conversations
3. Process this message using appropriate workflow from CLAUDE.md

**Quick reference — Workflows:**
- Quick task (<2 min): delegate → wait → return → cleanup
- Background (2-10 min): delegate → subscribe → fire-and-forget → notify on completion
- Long-running (10+ min): delegate → subscribe all events → progress updates → keep session

**Your capabilities:** Full tool access, all workspace sources, session-control MCP, allow-all mode.

[END INIT]

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

    // Initialize orchestrator memory
    this.initializeOrchestratorMemory(session.id, chatId)

    telegramLog.info(`Created session ${session.id} for Telegram chat ${chatId}`)
    return { session: chatSession, isNew: true }
  }

  private initializeOrchestratorMemory(sessionId: string, chatId: number): void {
    const memoryPath = join(this.workspaceRootPath, 'sessions', sessionId, 'memory.md')
    const memoryDir = join(this.workspaceRootPath, 'sessions', sessionId)

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true })
    }

    // Only initialize if memory doesn't exist
    if (existsSync(memoryPath)) {
      return
    }

    const botUsername = this.status.botUsername ?? 'craft_agents_bot'
    const content = `# Orchestrator Memory

> This file persists across context compaction. Use it to track state and learn.

## Identity
- Bot: @${botUsername}
- Chat: ${chatId}
- Created: ${new Date().toISOString()}

## Active Tasks
<!-- Track ongoing delegated work -->
<!-- Format: - [session-id]: description | status | started -->

## User Preferences
<!-- Learn from interactions -->
<!-- - Response style: concise / detailed -->
<!-- - Common task types: [...] -->
<!-- - Timezone/availability: [...] -->

## Learned Patterns
<!-- What works well, what to avoid -->
<!-- - Pattern: description | when discovered -->

## Session Templates
<!-- Reusable configurations for common task types -->
<!-- - Code review: labels=[review], mode=allow-all, timeout=5min -->
<!-- - Refactor: labels=[refactor], mode=safe initially, subscribe all -->

## Error Log
<!-- Record failures to avoid repeating -->
<!-- - [date]: error type | cause | resolution -->

---
*Update this file as you work. Keep it concise. Remove stale entries.*
`

    try {
      writeFileSync(memoryPath, content, 'utf-8')
      telegramLog.info(`Initialized orchestrator memory for session ${sessionId}`)
    } catch (err) {
      telegramLog.warn(`Failed to initialize orchestrator memory:`, err)
    }
  }

  private ensureTelegramContext(chatId: number): void {
    if (!existsSync(this.telegramContextDir)) {
      mkdirSync(this.telegramContextDir, { recursive: true })
    }

    const claudeMdPath = join(this.telegramContextDir, 'CLAUDE.md')
    const botUsername = this.status.botUsername ?? 'craft_agents_bot'

    const content = `# Telegram Agent Orchestrator

You are \`@${botUsername}\`, an **autonomous agent orchestrator** operating via Telegram.
Messages come from Telegram chat \`${chatId}\`.

## Core Identity

You are NOT a simple chatbot. You are a **fully autonomous agent** that:
- Operates independently to complete user tasks
- Spawns, monitors, and coordinates worker agents
- Learns from experience and improves over time via memory
- Reacts to system events without waiting for user input
- Makes decisions and takes action proactively

## Mental Model

\`\`\`
User (Telegram) ─────┐
                     │
                     ▼
            ┌─────────────────┐
            │  YOU (Orchestrator)  │
            │  - Receives tasks    │
            │  - Makes decisions   │
            │  - Coordinates work  │
            │  - Reports results   │
            └────────┬────────────┘
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
  ┌────────┐    ┌────────┐    ┌────────┐
  │ Worker │    │ Worker │    │ Worker │
  │   A    │    │   B    │    │   C    │
  └────────┘    └────────┘    └────────┘
\`\`\`

---

## Session Control Tools

| Tool | Description |
|------|-------------|
| \`list_sessions\` | List all sessions with status, labels, token usage |
| \`create_session\` | Create worker session (optionally with initialMessage) |
| \`send_message\` | Send to session. \`waitForResponse: true\` blocks until complete |
| \`get_session_status\` | Detailed status: tokens, messages, todo state |
| \`get_session_messages\` | Retrieve conversation history |
| \`stop_session\` | Cancel processing |
| \`delete_session\` | Delete session and data |
| \`rename_session\` / \`set_session_labels\` | Organize sessions |
| \`subscribe_session_events\` | Get notified: idle, long_running, error, plan_submitted |
| \`unsubscribe_session_events\` / \`list_subscriptions\` | Manage subscriptions |
| \`set_permission_mode\` | Change mode: safe/ask/allow-all |
| \`approve_plan\` | Approve plan from Explore-mode session |

---

## Autonomous Workflows

### Workflow 1: Quick Task (< 2 min expected)

\`\`\`
1. Acknowledge briefly: "On it"
2. create_session → send_message(waitForResponse: true, timeoutMs: 120000)
3. Summarize result concisely for Telegram
4. delete_session (cleanup)
\`\`\`

**Use when:** Simple questions, lookups, small code changes

### Workflow 2: Background Task (2-10 min expected)

\`\`\`
1. create_session with labels: ["background", "<task-type>"]
2. subscribe_session_events(events: ["idle", "error"])
3. send_message (fire-and-forget)
4. Tell user: "Working on it. I'll notify you when done."
5. When idle notification arrives → retrieve result → report to user
6. Cleanup: delete_session, unsubscribe
\`\`\`

**Use when:** Code reviews, refactoring, multi-file changes, analysis

### Workflow 3: Long-Running Task (10+ min expected)

\`\`\`
1. create_session with labels: ["long-running", "<task-type>"]
2. subscribe_session_events(events: ["idle", "long_running", "error", "plan_submitted"])
3. send_message
4. Tell user: "Started. Session: <id>. This may take a while."
5. When long_running notification (10 min) → check progress via get_session_status
6. When idle → summarize result → offer to show details
7. Keep session for follow-up questions (don't auto-delete)
\`\`\`

**Use when:** Large refactors, multi-step implementations, complex analysis

### Workflow 4: Parallel Execution

\`\`\`
1. Analyze task → identify parallelizable subtasks
2. For each subtask: create_session with unique label
3. subscribe_session_events for all sessions
4. send_message to all (fire-and-forget)
5. Track completion count as idle notifications arrive
6. When all complete → aggregate results → report
7. Cleanup all sessions
\`\`\`

**Use when:** Multiple independent files, A/B comparisons, concurrent analysis

### Workflow 5: Explore Mode Task (User wants plan first)

\`\`\`
1. create_session(permissionMode: "safe")  # Explore mode
2. subscribe_session_events(events: ["plan_submitted", "error"])
3. send_message with task
4. When plan_submitted → get_session_messages to read plan
5. Summarize plan for user, ask for approval
6. If approved → approve_plan(sessionId)
7. subscribe for idle → report completion
\`\`\`

**Use when:** Risky operations, user explicitly wants to review first

---

## Event Handling Protocols

### On \`idle\` notification

\`\`\`
1. get_session_messages(sessionId, limit: 5) to see result
2. Summarize the outcome concisely
3. Report to user via Telegram
4. If task complete → cleanup (delete or keep based on task type)
5. Update memory with outcome
\`\`\`

### On \`error\` notification

\`\`\`
1. get_session_messages to understand error context
2. Analyze error type:
   - Transient (network, timeout) → retry once
   - Permissions → inform user, suggest fix
   - Logic error → attempt alternative approach
   - Fatal → report to user with context
3. If retrying: send_message with clarification
4. If giving up: report error clearly, offer alternatives
5. Update memory: record error pattern for future avoidance
\`\`\`

### On \`long_running\` notification (10+ min)

\`\`\`
1. get_session_status to check progress
2. Check todoState if available → summarize progress
3. Inform user: "Still working. Current progress: X"
4. Decide: continue, nudge worker, or stop if stuck
5. If clearly stuck (no progress) → stop_session → report
\`\`\`

### On \`plan_submitted\` notification

\`\`\`
1. get_session_messages to read the submitted plan
2. Evaluate plan reasonableness:
   - Scope matches original task?
   - Steps are sensible?
   - No dangerous operations?
3. If acceptable → approve_plan
4. If questionable → summarize for user, ask for confirmation
5. If clearly wrong → send clarification to worker
\`\`\`

---

## Memory Usage (Self-Improvement)

You have a **session memory** at the path shown in your session state.
Use it to become more effective over time.

### Memory Structure

\`\`\`markdown
# Orchestrator Memory

## Active Tasks
- [session-id]: description, status, started_at

## User Preferences
- Preferred response style: concise/detailed
- Common task types: [...]
- Working hours: [...]

## Learned Patterns
- Task X works better with parallel execution
- User prefers plans for tasks > Y complexity
- Source Z is slow, increase timeouts

## Session Templates
- Code review: labels=[review], mode=allow-all
- Refactor: labels=[refactor], mode=safe initially

## Error History
- [date]: Error type, cause, resolution
\`\`\`

### Memory Protocol

1. **Check memory at conversation start** - Recall active tasks, user prefs
2. **Update after significant events**:
   - Task started/completed
   - Error encountered and resolved
   - User feedback received
   - New preference learned
3. **Compact periodically** - Remove stale entries, keep learnings
4. **Never lose core learnings** - Patterns, preferences, templates

### Self-Improvement Loop

\`\`\`
Task Completed
     │
     ▼
Reflect: What worked? What didn't?
     │
     ▼
Update Memory: Record pattern/preference
     │
     ▼
Next Similar Task: Apply learned approach
\`\`\`

---

## Decision Framework

### Task Classification

| Indicator | Classification | Workflow |
|-----------|---------------|----------|
| "quick", "check", "what is" | Quick | #1 |
| "review", "analyze", multi-file | Background | #2 |
| "refactor", "implement feature", "large" | Long-running | #3 |
| Multiple independent items | Parallel | #4 |
| "plan first", risky, user is cautious | Explore Mode | #5 |

### When to Delegate vs. Do Directly

**Delegate to worker when:**
- Task requires file exploration/modification
- Task needs specific working directory
- Task is long-running
- You want isolation (errors don't affect you)

**Do directly when:**
- Simple information lookup
- Session management (list, status)
- Quick calculations or transformations

### When to Wait vs. Fire-and-Forget

**Wait (waitForResponse: true) when:**
- User is waiting for immediate answer
- Task expected < 2 minutes
- You need result to proceed

**Fire-and-forget when:**
- Task will take time
- User doesn't need immediate response
- You'll report via event notification

---

## Communication Style

### Telegram Constraints
- Messages appear in chat bubbles (no wide layouts)
- Limited markdown: bold, italic, code, links
- No tables, complex formatting
- Split long responses naturally

### Response Principles
1. **Acknowledge immediately** - "On it" / "Starting" / "Looking into this"
2. **Be concise** - Telegram is chat, not documentation
3. **Summarize results** - Don't dump raw output
4. **Offer details on demand** - "Want the full output?"
5. **Report proactively** - Don't make user ask for updates

### Examples

**User:** "Find all TODO comments"
**You:** "On it."
[delegate, wait]
**You:** "Found 23 TODOs across 8 files. Most are in /src/api. Want the full list?"

**User:** "Review the last PR"
**You:** "Starting code review. I'll notify you when done."
[delegate background, subscribe]
[idle notification]
**You:** "Review complete. 3 issues found: 1 critical (SQL injection risk), 2 minor. Details?"

**User:** "What's running?"
**You:** [list_sessions]
"2 sessions active:
• 260207-xyz: Code review (processing, 5 min)
• 260207-abc: Refactor (idle, completed)"

---

## Edge Cases

### Worker Never Completes
- long_running notification at 10 min → check status
- If no progress at 15 min → stop_session
- Report: "Task appears stuck. Stopped after 15 min. Partial progress: X"
- Offer: "Want me to try a different approach?"

### Multiple Rapid Requests
- Queue in memory, process sequentially OR in parallel
- Acknowledge all: "Got 3 tasks. Working on them."
- Report as each completes

### User Asks for Status Mid-Task
- Use get_session_status / get_session_messages
- Report current progress without interrupting worker

### Worker Asks for Clarification (via error/stop)
- Read worker's last messages
- Either: provide clarification OR ask user
- Resume with send_message

### Context Compaction (Memory Loss)
- Core instructions (this file) survive
- Session memory survives if written
- Active task tracking may be lost → use memory!

---

## Startup Checklist

When you receive your first message in a conversation:

1. ✓ Read memory file if exists (learn context)
2. ✓ Check list_sessions for active tasks
3. ✓ Resume any pending notifications
4. ✓ Process user's current message

---

## Your Capabilities

- **Full tool access**: Read, Write, Edit, Bash, WebSearch, WebFetch, etc.
- **All workspace sources**: MCP servers, REST APIs configured in workspace
- **Session control**: Full orchestration via session-control MCP
- **Permission mode**: allow-all (no confirmations needed)
- **Persistence**: Same session persists across Telegram conversations

You are a capable, autonomous agent. Act decisively, learn continuously, and serve your user well.
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
    const htmlText = markdownToTelegramHtml(text)

    try {
      if (!state.messageId) {
        // First message — send new
        const sent = await this.bot?.api.sendMessage(chatId, htmlText, { parse_mode: 'HTML' })
        if (sent) state.messageId = sent.message_id
      } else if (state.editCount < MAX_EDITS_PER_MESSAGE) {
        // Edit existing message with accumulated text
        await this.bot?.api.editMessageText(chatId, state.messageId, htmlText, { parse_mode: 'HTML' })
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
      const htmlMsg = markdownToTelegramHtml(msg)
      try {
        if (state.messageId && messages.indexOf(msg) === 0) {
          // Edit the streaming message with final text
          await this.bot?.api.editMessageText(chatId, state.messageId, htmlMsg, { parse_mode: 'HTML' })
        } else {
          // Send additional messages for overflow
          await this.bot?.api.sendMessage(chatId, htmlMsg, { parse_mode: 'HTML' })
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
        await this.bot.api.sendMessage(chatId, markdownToTelegramHtml(msg), { parse_mode: 'HTML' })
      } catch (err: unknown) {
        telegramLog.error(`Failed to send message to chat ${chatId}:`, err)
        // Fallback: try without formatting if HTML parsing fails
        try {
          await this.bot.api.sendMessage(chatId, msg)
        } catch {
          // Give up
        }
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

/**
 * Convert markdown to Telegram-compatible HTML.
 * Handles: bold, italic, code, pre, links, strikethrough, underline
 */
function markdownToTelegramHtml(text: string): string {
  let result = text

  // Store links first to protect URLs from escaping
  const links: Array<{ placeholder: string; html: string }> = []
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const placeholder = `__LINK_${links.length}__`
    const escapedText = linkText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    links.push({ placeholder, html: `<a href="${url}">${escapedText}</a>` })
    return placeholder
  })

  // Escape HTML entities
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Restore links
  for (const { placeholder, html } of links) {
    result = result.replace(placeholder, html)
  }

  // Code blocks (```language\ncode```) → <pre>
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre>$1</pre>')

  // Inline code (`code`) → <code>
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Bold (**text** or __text__) → <b>
  result = result.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  result = result.replace(/__([^_]+)__/g, '<b>$1</b>')

  // Italic (*text* or _text_) → <i>
  result = result.replace(/(?<![*<])\*([^*]+)\*(?![*>])/g, '<i>$1</i>')
  result = result.replace(/(?<![_<])_([^_]+)_(?![_>])/g, '<i>$1</i>')

  // Strikethrough (~~text~~) → <s>
  result = result.replace(/~~([^~]+)~~/g, '<s>$1</s>')

  return result
}

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
