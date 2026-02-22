/**
 * Scheduled Tasks Module
 *
 * User-configurable automated tasks with scheduling and event triggers.
 * Tasks can run actions like auto-labeling, AI classification, summarization, etc.
 */

// Types
export type {
  TaskTriggerType,
  TaskEventType,
  TaskTrigger,
  TaskActionType,
  TaskAction,
  TaskSessionFilter,
  TaskScope,
  ScheduledTask,
  WorkspaceTaskConfig,
  CreateTaskInput,
  UpdateTaskInput,
  TaskResult,
  TaskRun,
  TaskState,
  TasksStateFile,
  TaskWithState,
  TaskSchedulerEvent,
} from './types.ts';

// Validation
export {
  // Schemas
  TaskEventTypeSchema,
  TaskTriggerSchema,
  TaskActionSchema,
  TaskSessionFilterSchema,
  TaskScopeSchema,
  ScheduledTaskSchema,
  WorkspaceTaskConfigSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  TaskResultSchema,
  TaskRunSchema,
  TaskStateSchema,
  TasksStateFileSchema,
  // Functions
  validateCronExpression,
  validateTaskConfigContent,
  validateTask,
  validateCreateTaskInput,
  validateUpdateTaskInput,
} from './validation.ts';

export type {
  ValidationIssue,
  ValidationResult,
} from './validation.ts';

// Storage
export {
  // Config
  getDefaultTaskConfig,
  getTasksDir,
  getTasksConfigPath,
  getTasksStatePath,
  getGlobalTasksDir,
  getGlobalTasksConfigPath,
  getGlobalTasksStatePath,
  ensureTasksDir,
  loadTaskConfig,
  saveTaskConfig,
  loadGlobalTaskConfig,
  saveGlobalTaskConfig,
  // State
  getDefaultTaskStateFile,
  loadTaskState,
  saveTaskState,
  loadGlobalTaskState,
  saveGlobalTaskState,
  // CRUD
  getTask,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  toggleTask,
  // State ops
  getTaskState,
  markTaskRunning,
  recordTaskRun,
  updateNextRun,
  // Bulk
  listTasksWithState,
  listEnabledTasks,
  isValidTaskId,
} from './storage.ts';
