/**
 * Scheduled Task Types
 *
 * Types for configurable scheduled tasks.
 * Tasks are automated jobs that run on schedules or in response to events.
 * Stored at {workspaceRootPath}/tasks/config.json (workspace-scoped)
 * or ~/.craft-agent/tasks/config.json (global)
 *
 * Architecture:
 * - Tasks have triggers (cron, interval, event)
 * - Tasks have actions (auto-label, ai-label, summarize, etc.)
 * - Tasks have scope (which sessions to process)
 * - Runtime state (lastRun, history) stored separately from config
 */

/**
 * Trigger types: when the task should run
 */
export type TaskTriggerType = 'cron' | 'interval' | 'event';

/**
 * Events that can trigger tasks
 */
export type TaskEventType =
  | 'session_created'
  | 'session_changed'
  | 'session_completed'
  | 'label_changed';

/**
 * Task trigger configuration
 */
export type TaskTrigger =
  | { type: 'cron'; cron: string }              // "*/10 * * * *" = every 10 min
  | { type: 'interval'; intervalMs: number }    // 600000 = 10 min
  | { type: 'event'; event: TaskEventType; debounceMs?: number };

/**
 * Action types: what the task does
 */
export type TaskActionType =
  | 'auto-label'
  | 'ai-label'
  | 'summarize'
  | 'semantic-index'
  | 'webhook'
  | 'custom';

/**
 * Task action configuration - polymorphic by type
 */
export type TaskAction =
  | { type: 'auto-label' }
  | {
      type: 'ai-label';
      prompt: string;
      model?: string;
      labels?: string[];
    }
  | {
      type: 'summarize';
      maxLength?: number;
    }
  | { type: 'semantic-index' }
  | {
      type: 'webhook';
      url: string;
      method?: 'POST' | 'PUT';
      headers?: Record<string, string>;
    }
  | {
      type: 'custom';
      command: string;
    };

/**
 * Session filter criteria for task scope
 */
export interface TaskSessionFilter {
  /** Only process sessions modified since last run */
  modifiedSince?: 'lastRun';

  /** Only process sessions with these labels */
  labels?: string[];

  /** Exclude sessions with these labels */
  excludeLabels?: string[];

  /** Ignore sessions older than N days */
  maxAgeDays?: number;

  /** Skip sessions with fewer than N messages */
  minMessages?: number;
}

/**
 * Task scope: which sessions to process
 */
export interface TaskScope {
  /** Limit to specific workspace (null = all workspaces) */
  workspaceId?: string;

  /** Session filtering criteria */
  sessionFilter?: TaskSessionFilter;
}

/**
 * Complete scheduled task configuration
 */
export interface ScheduledTask {
  /** Unique ID (UUID) */
  id: string;

  /** Display name */
  name: string;

  /** Optional description */
  description?: string;

  /** Whether the task is active */
  enabled: boolean;

  /** When the task was created */
  createdAt: string;

  /** When the task was last modified */
  updatedAt: string;

  /** Trigger configuration (when to run) */
  trigger: TaskTrigger;

  /** Action configuration (what to do) */
  action: TaskAction;

  /** Scope configuration (which sessions) */
  scope: TaskScope;
}

/**
 * Workspace tasks configuration file
 */
export interface WorkspaceTaskConfig {
  /** Schema version for migrations */
  version: number;

  /** Array of scheduled tasks */
  tasks: ScheduledTask[];
}

/**
 * Input for creating a new task
 */
export interface CreateTaskInput {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: TaskTrigger;
  action: TaskAction;
  scope?: TaskScope;
}

/**
 * Input for updating an existing task
 */
export interface UpdateTaskInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: TaskTrigger;
  action?: TaskAction;
  scope?: TaskScope;
}

// ============================================================================
// Runtime State Types (stored separately from config)
// ============================================================================

/**
 * Result of a single task execution
 */
export interface TaskResult {
  /** Whether the task completed successfully */
  success: boolean;

  /** When the task started */
  startedAt: string;

  /** When the task completed */
  completedAt: string;

  /** Number of sessions processed */
  sessionsProcessed: number;

  /** Number of sessions modified (labels changed, etc.) */
  sessionsModified: number;

  /** Error message if failed */
  error?: string;
}

/**
 * A single task execution record
 */
export interface TaskRun {
  /** Unique run ID */
  runId: string;

  /** Result of the run */
  result: TaskResult;

  /** What triggered this run */
  triggeredBy: 'schedule' | 'manual' | 'event';

  /** Event details if triggered by event */
  eventDetails?: {
    type: TaskEventType;
    sessionId?: string;
    workspaceId?: string;
  };
}

/**
 * Runtime state for a task (persisted separately from config)
 */
export interface TaskState {
  /** Task ID this state belongs to */
  taskId: string;

  /** Last time the task ran */
  lastRun?: string;

  /** Result of the last run */
  lastResult?: TaskResult;

  /** Recent run history (last N runs) */
  runHistory?: TaskRun[];

  /** Next scheduled run time (for UI display) */
  nextRun?: string;

  /** Whether the task is currently running */
  isRunning?: boolean;
}

/**
 * Tasks runtime state file
 */
export interface TasksStateFile {
  /** Schema version */
  version: number;

  /** State for each task by ID */
  tasks: Record<string, TaskState>;
}

// ============================================================================
// IPC Types (for renderer <-> main communication)
// ============================================================================

/**
 * Task with its runtime state merged (for UI display)
 */
export interface TaskWithState extends ScheduledTask {
  state: TaskState;
}

/**
 * Events emitted by the task scheduler
 */
export type TaskSchedulerEvent =
  | { type: 'task_started'; taskId: string; runId: string }
  | { type: 'task_completed'; taskId: string; runId: string; result: TaskResult }
  | { type: 'task_error'; taskId: string; runId: string; error: string }
  | { type: 'task_progress'; taskId: string; runId: string; processed: number; total: number };
