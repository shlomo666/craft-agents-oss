/**
 * TaskScheduler — Background task scheduling for Craft Agents
 *
 * Manages scheduled tasks (cron, interval, event-driven) in the main process.
 * Tasks are executed by the TaskExecutor which handles session iteration
 * and action dispatch.
 *
 * Architecture:
 *   TaskScheduler (this file)
 *   ├── Timer Pool (setInterval/setTimeout for time-based triggers)
 *   ├── Event Bus (listens for session events)
 *   └── Execution Queue (rate-limited task execution)
 *         │
 *         ▼
 *   TaskExecutor → Task Actions (auto-label, ai-label, etc.)
 */

import { parseExpression } from 'cron-parser'
import { randomUUID } from 'crypto'
import log from './logger'
import type { SessionManager } from './sessions'
import type { WindowManager } from './window-manager'
import {
  type ScheduledTask,
  type TaskTrigger,
  type TaskEventType,
  type TaskResult,
  type TaskRun,
  type TaskSchedulerEvent,
  loadTaskConfig,
  loadTaskState,
  markTaskRunning,
  recordTaskRun,
  updateNextRun,
  listEnabledTasks,
} from '@craft-agent/shared/tasks'
import { TaskExecutor } from './task-executor'

const taskLog = log.scope('tasks')

/** Minimum interval between task runs (prevent runaway) */
const MIN_INTERVAL_MS = 10_000 // 10 seconds

/** Default debounce for event-driven tasks */
const DEFAULT_EVENT_DEBOUNCE_MS = 30_000 // 30 seconds

/** Maximum concurrent task executions */
const MAX_CONCURRENT_EXECUTIONS = 3

interface RegisteredTask {
  task: ScheduledTask
  workspaceRootPath: string
  timerId?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>
  nextRunTime?: Date
}

interface EventDebounce {
  timerId: ReturnType<typeof setTimeout>
  sessionIds: Set<string>
}

export class TaskScheduler {
  private sessionManager: SessionManager
  private windowManager: WindowManager
  private executor: TaskExecutor

  // Registered tasks by ID
  private registeredTasks: Map<string, RegisteredTask> = new Map()

  // Event-driven task debouncing
  private eventDebounces: Map<string, EventDebounce> = new Map() // taskId → debounce state

  // Execution queue
  private executionQueue: Array<{ taskId: string; workspaceRootPath: string; triggeredBy: 'schedule' | 'manual' | 'event'; eventDetails?: any }> = []
  private activeExecutions = 0
  private processingQueue = false

  // Workspace paths we're tracking
  private trackedWorkspaces: Set<string> = new Set()

  // Running state
  private started = false

  constructor(sessionManager: SessionManager, windowManager: WindowManager) {
    this.sessionManager = sessionManager
    this.windowManager = windowManager
    this.executor = new TaskExecutor(sessionManager)
  }

  /**
   * Start the task scheduler
   * Loads all enabled tasks from tracked workspaces and sets up timers
   */
  async start(): Promise<void> {
    if (this.started) {
      taskLog.warn('TaskScheduler already started')
      return
    }

    this.started = true
    taskLog.info('TaskScheduler starting...')

    // Load tasks from all tracked workspaces
    for (const workspaceRootPath of this.trackedWorkspaces) {
      await this.loadWorkspaceTasks(workspaceRootPath)
    }

    taskLog.info(`TaskScheduler started with ${this.registeredTasks.size} tasks`)
  }

  /**
   * Stop the task scheduler
   * Clears all timers and pending executions
   */
  async stop(): Promise<void> {
    if (!this.started) return

    taskLog.info('TaskScheduler stopping...')

    // Clear all timers
    for (const [taskId, registered] of this.registeredTasks) {
      if (registered.timerId) {
        clearTimeout(registered.timerId as ReturnType<typeof setTimeout>)
        clearInterval(registered.timerId as ReturnType<typeof setInterval>)
      }
    }
    this.registeredTasks.clear()

    // Clear debounces
    for (const debounce of this.eventDebounces.values()) {
      clearTimeout(debounce.timerId)
    }
    this.eventDebounces.clear()

    // Clear execution queue
    this.executionQueue = []

    this.started = false
    taskLog.info('TaskScheduler stopped')
  }

  /**
   * Track a workspace for task scheduling
   * Should be called when workspace is loaded/activated
   */
  async trackWorkspace(workspaceRootPath: string): Promise<void> {
    if (this.trackedWorkspaces.has(workspaceRootPath)) {
      return
    }

    this.trackedWorkspaces.add(workspaceRootPath)
    taskLog.info(`Tracking workspace: ${workspaceRootPath}`)

    if (this.started) {
      await this.loadWorkspaceTasks(workspaceRootPath)
    }
  }

  /**
   * Stop tracking a workspace
   * Should be called when workspace is removed
   */
  untrackWorkspace(workspaceRootPath: string): void {
    this.trackedWorkspaces.delete(workspaceRootPath)

    // Remove all tasks from this workspace
    for (const [taskId, registered] of this.registeredTasks) {
      if (registered.workspaceRootPath === workspaceRootPath) {
        this.unregisterTask(taskId)
      }
    }

    taskLog.info(`Untracked workspace: ${workspaceRootPath}`)
  }

  /**
   * Load all enabled tasks from a workspace
   */
  private async loadWorkspaceTasks(workspaceRootPath: string): Promise<void> {
    const tasks = listEnabledTasks(workspaceRootPath)

    for (const task of tasks) {
      this.registerTask(task, workspaceRootPath)
    }

    taskLog.info(`Loaded ${tasks.length} tasks from workspace`)
  }

  /**
   * Register a task with the scheduler
   */
  registerTask(task: ScheduledTask, workspaceRootPath: string): void {
    // Unregister if already registered (to update)
    if (this.registeredTasks.has(task.id)) {
      this.unregisterTask(task.id)
    }

    if (!task.enabled) {
      taskLog.info(`Skipping disabled task: ${task.name}`)
      return
    }

    const registered: RegisteredTask = {
      task,
      workspaceRootPath,
    }

    // Set up timer based on trigger type
    switch (task.trigger.type) {
      case 'interval':
        this.setupIntervalTrigger(registered)
        break
      case 'cron':
        this.setupCronTrigger(registered)
        break
      case 'event':
        // Event triggers don't need timers, they react to events
        taskLog.info(`Registered event-triggered task: ${task.name} (${task.trigger.event})`)
        break
    }

    this.registeredTasks.set(task.id, registered)
    taskLog.info(`Registered task: ${task.name} (${task.trigger.type})`)
  }

  /**
   * Unregister a task from the scheduler
   */
  unregisterTask(taskId: string): void {
    const registered = this.registeredTasks.get(taskId)
    if (!registered) return

    // Clear timer
    if (registered.timerId) {
      clearTimeout(registered.timerId as ReturnType<typeof setTimeout>)
      clearInterval(registered.timerId as ReturnType<typeof setInterval>)
    }

    // Clear debounce
    const debounce = this.eventDebounces.get(taskId)
    if (debounce) {
      clearTimeout(debounce.timerId)
      this.eventDebounces.delete(taskId)
    }

    this.registeredTasks.delete(taskId)
    taskLog.info(`Unregistered task: ${registered.task.name}`)
  }

  /**
   * Reload tasks for a workspace (after config change)
   */
  async reloadWorkspaceTasks(workspaceRootPath: string): Promise<void> {
    // Remove existing tasks from this workspace
    for (const [taskId, registered] of this.registeredTasks) {
      if (registered.workspaceRootPath === workspaceRootPath) {
        this.unregisterTask(taskId)
      }
    }

    // Reload from config
    await this.loadWorkspaceTasks(workspaceRootPath)
  }

  // ─── Timer Setup ─────────────────────────────────────────────────────

  private setupIntervalTrigger(registered: RegisteredTask): void {
    const intervalMs = Math.max(
      (registered.task.trigger as { type: 'interval'; intervalMs: number }).intervalMs,
      MIN_INTERVAL_MS
    )

    // Calculate next run time
    const nextRun = new Date(Date.now() + intervalMs)
    registered.nextRunTime = nextRun
    updateNextRun(registered.workspaceRootPath, registered.task.id, nextRun.toISOString())

    // Set up interval
    registered.timerId = setInterval(() => {
      this.queueExecution(registered.task.id, registered.workspaceRootPath, 'schedule')

      // Update next run time
      const next = new Date(Date.now() + intervalMs)
      registered.nextRunTime = next
      updateNextRun(registered.workspaceRootPath, registered.task.id, next.toISOString())
    }, intervalMs)

    taskLog.info(`Interval task ${registered.task.name}: every ${intervalMs / 1000}s, next run: ${nextRun.toISOString()}`)
  }

  private setupCronTrigger(registered: RegisteredTask): void {
    const cronExpr = (registered.task.trigger as { type: 'cron'; cron: string }).cron

    try {
      const interval = parseExpression(cronExpr)
      const nextDate = interval.next().toDate()
      registered.nextRunTime = nextDate
      updateNextRun(registered.workspaceRootPath, registered.task.id, nextDate.toISOString())

      // Calculate delay until next run
      const delayMs = nextDate.getTime() - Date.now()

      // Schedule the next run
      this.scheduleCronRun(registered, cronExpr, delayMs)

      taskLog.info(`Cron task ${registered.task.name}: "${cronExpr}", next run: ${nextDate.toISOString()}`)
    } catch (error) {
      taskLog.error(`Invalid cron expression for task ${registered.task.name}: ${cronExpr}`, error)
    }
  }

  private scheduleCronRun(registered: RegisteredTask, cronExpr: string, delayMs: number): void {
    registered.timerId = setTimeout(() => {
      // Execute the task
      this.queueExecution(registered.task.id, registered.workspaceRootPath, 'schedule')

      // Schedule the next run
      try {
        const interval = parseExpression(cronExpr)
        const nextDate = interval.next().toDate()
        registered.nextRunTime = nextDate
        updateNextRun(registered.workspaceRootPath, registered.task.id, nextDate.toISOString())

        const nextDelayMs = nextDate.getTime() - Date.now()
        this.scheduleCronRun(registered, cronExpr, nextDelayMs)
      } catch (error) {
        taskLog.error(`Failed to schedule next cron run for ${registered.task.name}:`, error)
      }
    }, delayMs)
  }

  // ─── Event Handling ──────────────────────────────────────────────────

  /**
   * Handle session events (called by SessionManager)
   */
  handleSessionEvent(
    eventType: TaskEventType,
    sessionId: string,
    workspaceId: string
  ): void {
    if (!this.started) return

    // Find tasks that match this event
    for (const registered of this.registeredTasks.values()) {
      if (registered.task.trigger.type !== 'event') continue

      const trigger = registered.task.trigger as { type: 'event'; event: TaskEventType; debounceMs?: number }
      if (trigger.event !== eventType) continue

      // Check workspace scope
      if (registered.task.scope.workspaceId && registered.task.scope.workspaceId !== workspaceId) {
        continue
      }

      // Debounce the execution
      const debounceMs = trigger.debounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS
      this.debounceEventExecution(registered.task.id, registered.workspaceRootPath, sessionId, eventType, debounceMs)
    }
  }

  private debounceEventExecution(
    taskId: string,
    workspaceRootPath: string,
    sessionId: string,
    eventType: TaskEventType,
    debounceMs: number
  ): void {
    const existing = this.eventDebounces.get(taskId)

    if (existing) {
      // Add session to batch
      existing.sessionIds.add(sessionId)
      // Reset timer
      clearTimeout(existing.timerId)
      existing.timerId = setTimeout(() => {
        this.executeEventBatch(taskId, workspaceRootPath, eventType, existing.sessionIds)
        this.eventDebounces.delete(taskId)
      }, debounceMs)
    } else {
      // Create new debounce
      const sessionIds = new Set([sessionId])
      const timerId = setTimeout(() => {
        this.executeEventBatch(taskId, workspaceRootPath, eventType, sessionIds)
        this.eventDebounces.delete(taskId)
      }, debounceMs)

      this.eventDebounces.set(taskId, { timerId, sessionIds })
    }
  }

  private executeEventBatch(
    taskId: string,
    workspaceRootPath: string,
    eventType: TaskEventType,
    sessionIds: Set<string>
  ): void {
    taskLog.info(`Event batch for task ${taskId}: ${sessionIds.size} sessions (${eventType})`)

    this.queueExecution(taskId, workspaceRootPath, 'event', {
      type: eventType,
      sessionIds: Array.from(sessionIds),
    })
  }

  // ─── Execution Queue ─────────────────────────────────────────────────

  private queueExecution(
    taskId: string,
    workspaceRootPath: string,
    triggeredBy: 'schedule' | 'manual' | 'event',
    eventDetails?: any
  ): void {
    this.executionQueue.push({ taskId, workspaceRootPath, triggeredBy, eventDetails })
    this.processQueue()
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) return
    this.processingQueue = true

    while (this.executionQueue.length > 0 && this.activeExecutions < MAX_CONCURRENT_EXECUTIONS) {
      const item = this.executionQueue.shift()
      if (!item) break

      this.activeExecutions++
      this.executeTask(item.taskId, item.workspaceRootPath, item.triggeredBy, item.eventDetails)
        .finally(() => {
          this.activeExecutions--
          this.processQueue()
        })
    }

    this.processingQueue = false
  }

  private async executeTask(
    taskId: string,
    workspaceRootPath: string,
    triggeredBy: 'schedule' | 'manual' | 'event',
    eventDetails?: any
  ): Promise<void> {
    const registered = this.registeredTasks.get(taskId)
    if (!registered) {
      taskLog.warn(`Task ${taskId} not found, skipping execution`)
      return
    }

    const task = registered.task
    const runId = randomUUID()

    taskLog.info(`Executing task: ${task.name} (${triggeredBy})`)

    // Mark as running
    markTaskRunning(workspaceRootPath, taskId)
    this.broadcastEvent({ type: 'task_started', taskId, runId })

    const startedAt = new Date().toISOString()

    try {
      // Execute via TaskExecutor
      const result = await this.executor.execute(task, workspaceRootPath, eventDetails?.sessionIds)

      // Record the run
      const run: TaskRun = {
        runId,
        result,
        triggeredBy,
        eventDetails: eventDetails ? {
          type: eventDetails.type,
          sessionId: eventDetails.sessionIds?.[0],
          workspaceId: task.scope.workspaceId,
        } : undefined,
      }

      recordTaskRun(workspaceRootPath, taskId, run)
      this.broadcastEvent({ type: 'task_completed', taskId, runId, result })

      taskLog.info(`Task completed: ${task.name} - processed ${result.sessionsProcessed}, modified ${result.sessionsModified}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      const result: TaskResult = {
        success: false,
        startedAt,
        completedAt: new Date().toISOString(),
        sessionsProcessed: 0,
        sessionsModified: 0,
        error: errorMessage,
      }

      const run: TaskRun = {
        runId,
        result,
        triggeredBy,
        eventDetails: eventDetails ? {
          type: eventDetails.type,
          sessionId: eventDetails.sessionIds?.[0],
          workspaceId: task.scope.workspaceId,
        } : undefined,
      }

      recordTaskRun(workspaceRootPath, taskId, run)
      this.broadcastEvent({ type: 'task_error', taskId, runId, error: errorMessage })

      taskLog.error(`Task failed: ${task.name} - ${errorMessage}`)
    }
  }

  // ─── Manual Execution ────────────────────────────────────────────────

  /**
   * Manually trigger a task execution
   */
  async runTask(taskId: string, workspaceRootPath: string): Promise<void> {
    const task = this.registeredTasks.get(taskId)?.task
    if (!task) {
      // Try to load from config
      const config = loadTaskConfig(workspaceRootPath)
      const foundTask = config.tasks.find(t => t.id === taskId)
      if (!foundTask) {
        throw new Error(`Task ${taskId} not found`)
      }

      // Execute directly without registration
      this.queueExecution(taskId, workspaceRootPath, 'manual')
      return
    }

    this.queueExecution(taskId, workspaceRootPath, 'manual')
  }

  // ─── Event Broadcasting ──────────────────────────────────────────────

  private broadcastEvent(event: TaskSchedulerEvent): void {
    // Broadcast to all windows
    const windows = this.windowManager.getAllWindows()
    for (const managed of windows) {
      if (!managed.window.isDestroyed() &&
          !managed.window.webContents.isDestroyed() &&
          managed.window.webContents.mainFrame) {
        managed.window.webContents.send('task_event', event)
      }
    }
  }

  // ─── Status ──────────────────────────────────────────────────────────

  /**
   * Get scheduler status for debugging
   */
  getStatus(): {
    started: boolean
    taskCount: number
    activeExecutions: number
    queueLength: number
    trackedWorkspaces: string[]
  } {
    return {
      started: this.started,
      taskCount: this.registeredTasks.size,
      activeExecutions: this.activeExecutions,
      queueLength: this.executionQueue.length,
      trackedWorkspaces: Array.from(this.trackedWorkspaces),
    }
  }
}
