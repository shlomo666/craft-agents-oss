/**
 * TaskExecutor — Executes scheduled tasks against sessions
 *
 * Handles:
 * - Session filtering based on task scope
 * - Action dispatch (auto-label, ai-label, summarize, etc.)
 * - Result aggregation and reporting
 */

import log from './logger'
import type { SessionManager } from './sessions'
import type {
  ScheduledTask,
  TaskAction,
  TaskScope,
  TaskResult,
} from '@craft-agent/shared/tasks'
import {
  listSessions,
  loadSession,
  type SessionMetadata,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { getTaskState } from '@craft-agent/shared/tasks'
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto'
import { listLabels } from '@craft-agent/shared/labels/storage'

const execLog = log.scope('task-exec')

/** Result of executing an action on a single session */
interface ActionResult {
  modified: boolean
  error?: string
}

export class TaskExecutor {
  private sessionManager: SessionManager

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager
  }

  /**
   * Execute a task against matching sessions
   * @param task - The task configuration
   * @param workspaceRootPath - Workspace root path
   * @param sessionIds - Optional specific session IDs (for event-triggered tasks)
   */
  async execute(
    task: ScheduledTask,
    workspaceRootPath: string,
    sessionIds?: string[]
  ): Promise<TaskResult> {
    const startedAt = new Date().toISOString()
    let sessionsProcessed = 0
    let sessionsModified = 0
    let error: string | undefined

    try {
      // Get sessions to process
      const sessions = sessionIds
        ? this.getSessionsByIds(workspaceRootPath, sessionIds)
        : this.getMatchingSessions(task.scope, workspaceRootPath)

      execLog.info(`Processing ${sessions.length} sessions for task: ${task.name}`)

      // Process each session
      for (const session of sessions) {
        try {
          const result = await this.executeAction(task.action, session, workspaceRootPath)
          sessionsProcessed++
          if (result.modified) {
            sessionsModified++
          }
        } catch (err) {
          execLog.error(`Error processing session ${session.id}:`, err)
          // Continue with other sessions
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      execLog.error(`Task execution failed: ${error}`)
    }

    return {
      success: !error,
      startedAt,
      completedAt: new Date().toISOString(),
      sessionsProcessed,
      sessionsModified,
      error,
    }
  }

  /**
   * Get sessions by specific IDs
   */
  private getSessionsByIds(
    workspaceRootPath: string,
    sessionIds: string[]
  ): SessionMetadata[] {
    const allSessions = listSessions(workspaceRootPath)
    return allSessions.filter(s => sessionIds.includes(s.id))
  }

  /**
   * Get sessions matching the task scope
   */
  private getMatchingSessions(
    scope: TaskScope,
    workspaceRootPath: string
  ): SessionMetadata[] {
    let sessions = listSessions(workspaceRootPath)

    const filter = scope.sessionFilter
    if (!filter) {
      return sessions
    }

    // Filter by labels
    if (filter.labels && filter.labels.length > 0) {
      sessions = sessions.filter(s => {
        if (!s.labels) return false
        return filter.labels!.some(label => s.labels!.includes(label))
      })
    }

    // Filter by exclude labels
    if (filter.excludeLabels && filter.excludeLabels.length > 0) {
      sessions = sessions.filter(s => {
        if (!s.labels) return true
        return !filter.excludeLabels!.some(label => s.labels!.includes(label))
      })
    }

    // Filter by max age
    if (filter.maxAgeDays) {
      const cutoff = Date.now() - (filter.maxAgeDays * 24 * 60 * 60 * 1000)
      sessions = sessions.filter(s => s.lastUsedAt >= cutoff)
    }

    // Filter by min messages
    if (filter.minMessages) {
      sessions = sessions.filter(s => s.messageCount >= filter.minMessages!)
    }

    // Filter by modified since last run (incremental processing)
    if (filter.modifiedSince === 'lastRun') {
      // Get the last run time for this scope's tasks
      // This is a simplified implementation - in practice we'd need the taskId
      // For now, this filter is handled at the TaskScheduler level
    }

    return sessions
  }

  /**
   * Execute an action on a single session
   */
  private async executeAction(
    action: TaskAction,
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    switch (action.type) {
      case 'auto-label':
        return this.executeAutoLabel(session, workspaceRootPath)

      case 'ai-label':
        return this.executeAiLabel(action, session, workspaceRootPath)

      case 'summarize':
        return this.executeSummarize(action, session, workspaceRootPath)

      case 'semantic-index':
        return this.executeSemanticIndex(session, workspaceRootPath)

      case 'webhook':
        return this.executeWebhook(action, session, workspaceRootPath)

      case 'custom':
        return this.executeCustom(action, session, workspaceRootPath)

      default:
        execLog.warn(`Unknown action type: ${(action as any).type}`)
        return { modified: false }
    }
  }

  // ─── Action Implementations ──────────────────────────────────────────

  /**
   * Auto-label: Apply regex-based label rules
   */
  private async executeAutoLabel(
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    try {
      // Load the full session to get messages
      const storedSession = loadSession(session.workspaceRootPath, session.id)
      if (!storedSession) {
        return { modified: false, error: 'Session not found' }
      }

      // Get label configuration
      const labelTree = listLabels(workspaceRootPath)

      // Evaluate auto-label rules against all user messages
      const allMatches: { labelId: string; value: string }[] = []
      for (const message of storedSession.messages) {
        if (message.type === 'user') {
          const matches = evaluateAutoLabels(message, labelTree)
          allMatches.push(...matches)
        }
      }

      if (allMatches.length === 0) {
        return { modified: false }
      }

      // Get existing labels
      const existingLabels = session.labels || []

      // Build new label entries (dedupe and skip existing)
      const newEntries = allMatches
        .map(m => m.value ? `${m.labelId}::${m.value}` : m.labelId)
        .filter(entry => !existingLabels.includes(entry))

      if (newEntries.length === 0) {
        return { modified: false }
      }

      // Update labels via SessionManager
      // This will persist the changes and emit events
      const managed = this.sessionManager.getManagedSession(session.id)
      if (managed) {
        managed.labels = [...existingLabels, ...newEntries]
        this.sessionManager.persistSession(managed)
        execLog.info(`Auto-labeled session ${session.id}: +${newEntries.length} labels`)
        return { modified: true }
      }

      return { modified: false }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      execLog.error(`Auto-label failed for session ${session.id}:`, error)
      return { modified: false, error }
    }
  }

  /**
   * AI-label: Use LLM to classify sessions
   * TODO: Implement LLM integration
   */
  private async executeAiLabel(
    action: { type: 'ai-label'; prompt: string; model?: string; labels?: string[] },
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    execLog.warn('AI-label action not yet implemented')
    // TODO: Implement LLM-based classification
    // 1. Load session messages
    // 2. Build context from conversation
    // 3. Call LLM with classification prompt
    // 4. Parse response and apply labels
    return { modified: false }
  }

  /**
   * Summarize: Generate/update session summary
   * TODO: Implement summarization
   */
  private async executeSummarize(
    action: { type: 'summarize'; maxLength?: number },
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    execLog.warn('Summarize action not yet implemented')
    // TODO: Implement session summarization
    return { modified: false }
  }

  /**
   * Semantic-index: Build embeddings for semantic search
   * TODO: Implement semantic indexing
   */
  private async executeSemanticIndex(
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    execLog.warn('Semantic-index action not yet implemented')
    // TODO: Implement embedding generation
    return { modified: false }
  }

  /**
   * Webhook: POST session data to external URL
   */
  private async executeWebhook(
    action: { type: 'webhook'; url: string; method?: 'POST' | 'PUT'; headers?: Record<string, string> },
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    try {
      const response = await fetch(action.url, {
        method: action.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...action.headers,
        },
        body: JSON.stringify({
          sessionId: session.id,
          sessionName: session.name,
          labels: session.labels,
          messageCount: session.messageCount,
          lastUsedAt: session.lastUsedAt,
          workspacePath: workspaceRootPath,
        }),
      })

      if (!response.ok) {
        return { modified: false, error: `Webhook returned ${response.status}` }
      }

      return { modified: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { modified: false, error }
    }
  }

  /**
   * Custom: Run a shell command
   * TODO: Implement with proper sandboxing
   */
  private async executeCustom(
    action: { type: 'custom'; command: string },
    session: SessionMetadata,
    workspaceRootPath: string
  ): Promise<ActionResult> {
    execLog.warn('Custom action not yet implemented')
    // TODO: Implement with sandboxing and security controls
    return { modified: false }
  }
}
