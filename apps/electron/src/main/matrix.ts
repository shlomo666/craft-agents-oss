/**
 * MatrixService — Native Matrix integration for Craft Agents
 *
 * Runs in the Electron main process using matrix-js-sdk.
 * Incoming Matrix messages trigger full agent sessions with all tools,
 * sources, and MCP servers via SessionManager.
 *
 * Architecture:
 *   Matrix Homeserver ←→ matrix-js-sdk (sync) ←→ MatrixService ←→ SessionManager.sendMessage()
 *   Response: SessionManager events → formatForMatrix() → client.sendMessage()
 */

import * as sdk from 'matrix-js-sdk'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import log from './logger'
import type { SessionManager } from './sessions'
import type { SessionEvent } from '../shared/types'

const matrixLog = log.scope('matrix')

// Matrix message length limit (approximate, Matrix has no hard limit but we chunk for readability)
const MATRIX_MESSAGE_LIMIT = 4000

export interface MatrixStatus {
  connected: boolean
  userId: string | null
  homeserver: string | null
  hasCredentials: boolean
  localDetected: boolean
  error: string | null
}

interface RoomSession {
  roomId: string
  sessionId: string
  workspaceId: string
}

interface SessionResult {
  session: RoomSession
  isNew: boolean
}

export class MatrixService {
  private client: sdk.MatrixClient | null = null
  private sessionManager: SessionManager
  private workspaceRootPath: string
  private roomSessions: Map<string, RoomSession> = new Map()  // roomId → session info
  private eventUnsubscribers: Map<string, () => void> = new Map()  // sessionId → unsubscribe fn
  private status: MatrixStatus = {
    connected: false,
    userId: null,
    homeserver: null,
    hasCredentials: false,
    localDetected: false,
    error: null,
  }
  private mappingFilePath: string
  private matrixContextDir: string

  constructor(sessionManager: SessionManager, workspaceRootPath: string) {
    this.sessionManager = sessionManager
    this.workspaceRootPath = workspaceRootPath
    this.mappingFilePath = join(workspaceRootPath, 'matrix-sessions.json')
    this.matrixContextDir = join(workspaceRootPath, 'matrix')
    this.loadRoomSessions()
  }

  async connect(homeserver: string, accessToken: string): Promise<MatrixStatus> {
    if (this.client) {
      await this.disconnect()
    }

    this.status.hasCredentials = true
    this.status.error = null

    try {
      // Normalize homeserver URL
      const baseUrl = homeserver.startsWith('http') ? homeserver : `https://${homeserver}`

      // First get user ID with a temporary client
      const tempClient = sdk.createClient({ baseUrl, accessToken })
      const whoami = await tempClient.whoami()
      this.status.userId = whoami.user_id
      this.status.homeserver = baseUrl
      matrixLog.info(`Matrix authenticated as ${whoami.user_id}`)

      // Create the real client with proper userId
      this.client = sdk.createClient({
        baseUrl,
        accessToken,
        userId: whoami.user_id,
        timelineSupport: true,
      })

      // Set up sync state listener
      this.client.on(sdk.ClientEvent.Sync, (state, prevState) => {
        matrixLog.info(`Sync state: ${prevState} → ${state}`)
      })

      // Set up event listeners
      this.client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
        // Skip paginated/historical events
        if (toStartOfTimeline) return
        this.handleTimelineEvent(event, room)
      })

      // Auto-join rooms when invited
      this.client.on(sdk.RoomMemberEvent.Membership, (event, member) => {
        if (member.membership === 'invite' && member.userId === this.status.userId) {
          const roomId = event.getRoomId()
          if (roomId) {
            matrixLog.info(`Received invite to room ${roomId}, auto-joining...`)
            this.client?.joinRoom(roomId).then(() => {
              matrixLog.info(`Joined room ${roomId}`)
            }).catch(err => {
              matrixLog.error(`Failed to join room ${roomId}:`, err)
            })
          }
        }
      })

      // Start sync
      await this.client.startClient({ initialSyncLimit: 10 })

      this.status.connected = true
      this.status.error = null
      matrixLog.info('Matrix client started')

      return this.getStatus()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      matrixLog.error('Failed to connect to Matrix:', message)
      this.status.error = message
      this.status.connected = false
      this.client = null
      return this.getStatus()
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient()
      this.client = null
    }

    // Clean up all event subscriptions
    for (const unsub of this.eventUnsubscribers.values()) {
      unsub()
    }
    this.eventUnsubscribers.clear()

    this.status.connected = false
    this.status.error = null
    matrixLog.info('Matrix client disconnected')
  }

  getStatus(): MatrixStatus {
    return { ...this.status }
  }

  /**
   * Clear credential status (called after credentials are deleted from storage)
   */
  clearCredentialStatus(): void {
    this.status.hasCredentials = false
    this.status.userId = null
    this.status.homeserver = null
  }

  /**
   * Check if a local Matrix server is available at localhost:8443
   */
  async checkLocalServer(): Promise<{ available: boolean; version?: string }> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)

      // Try HTTP first (common for local dev setups), then HTTPS
      for (const protocol of ['http', 'https']) {
        const clientResponse = await fetch(`${protocol}://localhost:8443/_matrix/client/versions`, {
          signal: controller.signal,
        }).catch(() => null)

        if (clientResponse?.ok) {
          clearTimeout(timeout)
          const data = await clientResponse.json()
          this.status.localDetected = true
          return { available: true, version: data.versions?.[0] }
        }
      }

      clearTimeout(timeout)
      this.status.localDetected = false
      return { available: false }
    } catch {
      this.status.localDetected = false
      return { available: false }
    }
  }

  // ─── Message Handling ───────────────────────────────────────────────

  private handleTimelineEvent(event: sdk.MatrixEvent, room: sdk.Room | undefined): void {
    const eventType = event.getType()
    const roomId = event.getRoomId()
    const sender = event.getSender()

    matrixLog.info(`Timeline event: type=${eventType}, room=${roomId}, sender=${sender}`)

    // Only handle text messages
    if (eventType !== 'm.room.message') {
      matrixLog.info(`  → Skipped: not a message (type=${eventType})`)
      return
    }

    const content = event.getContent()
    if (content.msgtype !== 'm.text') {
      matrixLog.info(`  → Skipped: not text (msgtype=${content.msgtype})`)
      return
    }

    // Ignore our own messages
    if (sender === this.status.userId) {
      matrixLog.info(`  → Skipped: own message`)
      return
    }

    // Ignore messages that are too old (before we started)
    const messageAge = Date.now() - event.getTs()
    if (messageAge > 30000) {
      matrixLog.info(`  → Skipped: too old (age=${messageAge}ms)`)
      return
    }

    if (!roomId) {
      matrixLog.info(`  → Skipped: no roomId`)
      return
    }

    const text = content.body as string
    const senderName = room?.getMember(sender!)?.name

    matrixLog.info(`  → Processing message: "${text.slice(0, 50)}..."`)
    this.handleMessage(roomId, text, senderName).catch(err => {
      matrixLog.error(`Error handling message from room ${roomId}:`, err)
    })
  }

  private async handleMessage(roomId: string, text: string, senderName?: string): Promise<void> {
    matrixLog.info(`Message from room ${roomId}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`)

    try {
      const { session, isNew } = await this.getOrCreateSession(roomId)

      // Set up event listener for this session if not already listening
      this.ensureEventListener(session.sessionId, roomId)

      // Send "typing" indicator
      await this.client?.sendTyping(roomId, true, 30000)

      // On first message of a new session, prepend identity context
      const messageToSend = isNew ? this.buildFirstMessage(text, roomId, senderName) : text

      // Send message through the full agent pipeline
      await this.sessionManager.sendMessage(session.sessionId, messageToSend)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      matrixLog.error(`Error handling message from room ${roomId}:`, message)
      await this.sendMatrixMessage(roomId, `Error: ${message}`)
    }
  }

  private buildFirstMessage(text: string, roomId: string, senderName?: string): string {
    const userId = this.status.userId ?? 'craft-agent'
    return `[ORCHESTRATOR INIT — Room ${roomId}${senderName ? ` (${senderName})` : ''}]

You are ${userId}, an autonomous agent orchestrator connected via Matrix. Read your CLAUDE.md for full instructions.

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

  private async getOrCreateSession(roomId: string): Promise<SessionResult> {
    const existing = this.roomSessions.get(roomId)
    if (existing) {
      // Verify the session still exists
      const session = await this.sessionManager.getSession(existing.sessionId)
      if (session) {
        return { session: existing, isNew: false }
      }
      // Session was deleted — remove stale mapping
      matrixLog.info(`Session ${existing.sessionId} for room ${roomId} was deleted, creating new session`)
      this.roomSessions.delete(roomId)
      this.eventUnsubscribers.get(existing.sessionId)?.()
      this.eventUnsubscribers.delete(existing.sessionId)
    }

    // Write CLAUDE.md to shared matrix dir BEFORE session creation
    this.ensureMatrixContext(roomId)

    // Create session with workingDirectory pointing to the matrix context dir
    const { getActiveWorkspace } = await import('@craft-agent/shared/config')
    const workspace = getActiveWorkspace()
    if (!workspace) {
      throw new Error('No active workspace found')
    }

    const session = await this.sessionManager.createSession(workspace.id, {
      permissionMode: 'allow-all',
      workingDirectory: this.matrixContextDir,
    })

    const roomSession: RoomSession = {
      roomId,
      sessionId: session.id,
      workspaceId: workspace.id,
    }

    this.roomSessions.set(roomId, roomSession)
    this.saveRoomSessions()

    // Label the session as Matrix
    this.sessionManager.setSessionLabels(session.id, ['matrix'])

    // Initialize orchestrator memory
    this.initializeOrchestratorMemory(session.id, roomId)

    matrixLog.info(`Created session ${session.id} for Matrix room ${roomId}`)
    return { session: roomSession, isNew: true }
  }

  private initializeOrchestratorMemory(sessionId: string, roomId: string): void {
    const memoryPath = join(this.workspaceRootPath, 'sessions', sessionId, 'memory.md')
    const memoryDir = join(this.workspaceRootPath, 'sessions', sessionId)

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true })
    }

    if (existsSync(memoryPath)) {
      return
    }

    const userId = this.status.userId ?? 'craft-agent'
    const content = `# Orchestrator Memory

> This file persists across context compaction. Use it to track state and learn.

## Identity
- User: ${userId}
- Room: ${roomId}
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
      matrixLog.info(`Initialized orchestrator memory for session ${sessionId}`)
    } catch (err) {
      matrixLog.warn(`Failed to initialize orchestrator memory:`, err)
    }
  }

  private ensureMatrixContext(roomId: string): void {
    if (!existsSync(this.matrixContextDir)) {
      mkdirSync(this.matrixContextDir, { recursive: true })
    }

    const claudeMdPath = join(this.matrixContextDir, 'CLAUDE.md')
    const userId = this.status.userId ?? 'craft-agent'

    const content = `# Matrix Agent Orchestrator

You are \`${userId}\`, an **autonomous agent orchestrator** operating via Matrix.
Messages come from Matrix room \`${roomId}\`.

## Core Identity

You are NOT a simple chatbot. You are a **fully autonomous agent** that:
- Operates independently to complete user tasks
- Spawns, monitors, and coordinates worker agents
- Learns from experience and improves over time via memory
- Reacts to system events without waiting for user input
- Makes decisions and takes action proactively

## Your Capabilities

- **Full tool access**: Read, Write, Edit, Bash, WebSearch, WebFetch, etc.
- **All workspace sources**: MCP servers, REST APIs configured in workspace
- **Session control**: Full orchestration via session-control MCP
- **Permission mode**: allow-all (no confirmations needed)
- **Persistence**: Same session persists across Matrix conversations

## Communication Style

- Be concise — Matrix messages should be readable
- Acknowledge immediately — "On it" / "Starting"
- Report proactively — Don't make user ask for updates
- Summarize results — Don't dump raw output

You are a capable, autonomous agent. Act decisively, learn continuously, and serve your user well.
`

    try {
      writeFileSync(claudeMdPath, content, 'utf-8')
      matrixLog.info(`Wrote Matrix CLAUDE.md to ${this.matrixContextDir}`)
    } catch (err) {
      matrixLog.warn(`Failed to write Matrix CLAUDE.md:`, err)
    }
  }

  // ─── Event Bridging (Session Events → Matrix) ─────────────────────

  private ensureEventListener(sessionId: string, roomId: string): void {
    if (this.eventUnsubscribers.has(sessionId)) return

    const unsubscribe = this.sessionManager.onSessionEvent(sessionId, (event: SessionEvent) => {
      this.handleSessionEvent(sessionId, roomId, event)
    })

    this.eventUnsubscribers.set(sessionId, unsubscribe)
  }

  private handleSessionEvent(sessionId: string, roomId: string, event: SessionEvent): void {
    switch (event.type) {
      case 'text_complete':
        if (!event.isIntermediate) {
          this.sendMatrixMessage(roomId, event.text)
        }
        break

      case 'complete':
        // Stop typing indicator
        this.client?.sendTyping(roomId, false, 0).catch(() => {})
        break

      case 'error':
        this.sendMatrixMessage(roomId, `Error: ${event.error}`)
        break

      case 'typed_error':
        this.sendMatrixMessage(roomId, `Error: ${event.error.message}`)
        break
    }
  }

  // ─── Matrix Messaging ─────────────────────────────────────────────

  private async sendMatrixMessage(roomId: string, text: string): Promise<void> {
    if (!this.client) return

    const messages = this.splitMessage(text)
    for (const msg of messages) {
      try {
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: msg,
          format: 'org.matrix.custom.html',
          formatted_body: this.markdownToHtml(msg),
        })
      } catch (err: unknown) {
        matrixLog.error(`Failed to send message to room ${roomId}:`, err)
      }
    }
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MATRIX_MESSAGE_LIMIT) return [text]

    const messages: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= MATRIX_MESSAGE_LIMIT) {
        messages.push(remaining)
        break
      }

      // Try to split on paragraph boundary
      let splitAt = remaining.lastIndexOf('\n\n', MATRIX_MESSAGE_LIMIT)
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf('\n', MATRIX_MESSAGE_LIMIT)
      }
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(' ', MATRIX_MESSAGE_LIMIT)
      }
      if (splitAt <= 0) {
        splitAt = MATRIX_MESSAGE_LIMIT
      }

      messages.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }

    return messages
  }

  private markdownToHtml(text: string): string {
    let result = text

    // Escape HTML entities
    result = result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    // Code blocks
    result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')

    // Inline code
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>')

    // Bold
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

    // Italic
    result = result.replace(/(?<![*])\*([^*]+)\*(?![*])/g, '<em>$1</em>')

    // Links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

    // Line breaks
    result = result.replace(/\n/g, '<br>')

    return result
  }

  // ─── Persistence ────────────────────────────────────────────────────

  private loadRoomSessions(): void {
    try {
      if (existsSync(this.mappingFilePath)) {
        const data = JSON.parse(readFileSync(this.mappingFilePath, 'utf-8'))
        if (Array.isArray(data)) {
          for (const entry of data) {
            this.roomSessions.set(entry.roomId, entry)
          }
        }
        matrixLog.info(`Loaded ${this.roomSessions.size} Matrix room sessions`)
      }
    } catch (err) {
      matrixLog.warn('Failed to load Matrix room sessions:', err)
    }
  }

  private saveRoomSessions(): void {
    try {
      const dir = join(this.mappingFilePath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = Array.from(this.roomSessions.values())
      writeFileSync(this.mappingFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      matrixLog.warn('Failed to save Matrix room sessions:', err)
    }
  }
}
