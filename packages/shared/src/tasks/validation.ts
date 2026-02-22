/**
 * Task Validation
 *
 * Zod schemas and validation utilities for scheduled tasks.
 * Used to validate task configs before saving and runtime state before use.
 */

import { z } from 'zod';

// ============================================================
// Zod Schemas
// ============================================================

/**
 * Task event types that can trigger task execution
 */
export const TaskEventTypeSchema = z.enum([
  'session_created',
  'session_changed',
  'session_completed',
  'label_changed',
]);

/**
 * Task trigger types
 */
export const TaskTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cron'),
    cron: z.string().min(1, 'Cron expression is required'),
  }),
  z.object({
    type: z.literal('interval'),
    intervalMs: z.number().int().min(1000, 'Interval must be at least 1 second'),
  }),
  z.object({
    type: z.literal('event'),
    event: TaskEventTypeSchema,
    debounceMs: z.number().int().min(0).optional(),
  }),
]);

/**
 * Task action types
 */
export const TaskActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auto-label'),
  }),
  z.object({
    type: z.literal('ai-label'),
    prompt: z.string().min(1, 'AI label prompt is required'),
    model: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('summarize'),
    maxLength: z.number().int().min(50).max(10000).optional(),
  }),
  z.object({
    type: z.literal('semantic-index'),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().url('Webhook URL must be a valid URL'),
    method: z.enum(['POST', 'PUT']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('custom'),
    command: z.string().min(1, 'Custom command is required'),
  }),
]);

/**
 * Session filter criteria
 */
export const TaskSessionFilterSchema = z.object({
  modifiedSince: z.literal('lastRun').optional(),
  labels: z.array(z.string()).optional(),
  excludeLabels: z.array(z.string()).optional(),
  maxAgeDays: z.number().int().min(1).optional(),
  minMessages: z.number().int().min(0).optional(),
});

/**
 * Task scope configuration
 */
export const TaskScopeSchema = z.object({
  workspaceId: z.string().optional(),
  sessionFilter: TaskSessionFilterSchema.optional(),
});

/**
 * Complete scheduled task configuration
 */
export const ScheduledTaskSchema = z.object({
  id: z.string().uuid('Task ID must be a valid UUID'),
  name: z.string().min(1, 'Task name is required').max(100, 'Task name too long'),
  description: z.string().max(500, 'Description too long').optional(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  trigger: TaskTriggerSchema,
  action: TaskActionSchema,
  scope: TaskScopeSchema,
});

/**
 * Workspace tasks configuration file
 */
export const WorkspaceTaskConfigSchema = z.object({
  version: z.number().int().min(1),
  tasks: z.array(ScheduledTaskSchema),
});

/**
 * Create task input (partial, ID and timestamps added automatically)
 */
export const CreateTaskInputSchema = z.object({
  name: z.string().min(1, 'Task name is required').max(100, 'Task name too long'),
  description: z.string().max(500, 'Description too long').optional(),
  enabled: z.boolean().optional().default(true),
  trigger: TaskTriggerSchema,
  action: TaskActionSchema,
  scope: TaskScopeSchema.optional().default({}),
});

/**
 * Update task input (all fields optional)
 */
export const UpdateTaskInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  trigger: TaskTriggerSchema.optional(),
  action: TaskActionSchema.optional(),
  scope: TaskScopeSchema.optional(),
});

// ============================================================
// Runtime State Schemas
// ============================================================

/**
 * Task execution result
 */
export const TaskResultSchema = z.object({
  success: z.boolean(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  sessionsProcessed: z.number().int().min(0),
  sessionsModified: z.number().int().min(0),
  error: z.string().optional(),
});

/**
 * Single task run record
 */
export const TaskRunSchema = z.object({
  runId: z.string().uuid(),
  result: TaskResultSchema,
  triggeredBy: z.enum(['schedule', 'manual', 'event']),
  eventDetails: z.object({
    type: TaskEventTypeSchema,
    sessionId: z.string().optional(),
    workspaceId: z.string().optional(),
  }).optional(),
});

/**
 * Runtime state for a task
 */
export const TaskStateSchema = z.object({
  taskId: z.string().uuid(),
  lastRun: z.string().datetime().optional(),
  lastResult: TaskResultSchema.optional(),
  runHistory: z.array(TaskRunSchema).optional(),
  nextRun: z.string().datetime().optional(),
  isRunning: z.boolean().optional(),
});

/**
 * Tasks state file
 */
export const TasksStateFileSchema = z.object({
  version: z.number().int().min(1),
  tasks: z.record(z.string(), TaskStateSchema),
});

// ============================================================
// Validation Functions
// ============================================================

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Convert Zod error to ValidationIssues
 */
function zodErrorToIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Validate a cron expression
 * Returns error message if invalid, null if valid
 */
export function validateCronExpression(cron: string): string | null {
  // Basic cron format: minute hour dayOfMonth month dayOfWeek
  // Also supports extended format with seconds
  const parts = cron.trim().split(/\s+/);

  if (parts.length < 5 || parts.length > 6) {
    return `Invalid cron expression: expected 5-6 parts, got ${parts.length}`;
  }

  // Very basic validation - just check for valid characters
  const cronPattern = /^[\d*,\-\/]+$/;
  for (const part of parts) {
    if (!cronPattern.test(part)) {
      return `Invalid cron part: ${part}`;
    }
  }

  return null;
}

/**
 * Validate task config JSON content
 */
export function validateTaskConfigContent(jsonString: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = WorkspaceTaskConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validations

  // 1. Check for duplicate task IDs
  const seenIds = new Set<string>();
  for (const task of config.tasks) {
    if (seenIds.has(task.id)) {
      errors.push({
        path: `tasks[id=${task.id}]`,
        message: `Duplicate task ID '${task.id}'`,
        severity: 'error',
        suggestion: 'Each task must have a unique ID',
      });
    }
    seenIds.add(task.id);
  }

  // 2. Check for duplicate task names
  const seenNames = new Set<string>();
  for (const task of config.tasks) {
    if (seenNames.has(task.name.toLowerCase())) {
      warnings.push({
        path: `tasks[name=${task.name}]`,
        message: `Duplicate task name '${task.name}'`,
        severity: 'warning',
        suggestion: 'Consider using unique names for clarity',
      });
    }
    seenNames.add(task.name.toLowerCase());
  }

  // 3. Validate cron expressions
  for (const task of config.tasks) {
    if (task.trigger.type === 'cron') {
      const cronError = validateCronExpression(task.trigger.cron);
      if (cronError) {
        errors.push({
          path: `tasks[id=${task.id}].trigger.cron`,
          message: cronError,
          severity: 'error',
          suggestion: 'Use standard cron format: minute hour dayOfMonth month dayOfWeek',
        });
      }
    }
  }

  // 4. Check for very frequent intervals (warning)
  for (const task of config.tasks) {
    if (task.trigger.type === 'interval' && task.trigger.intervalMs < 60000) {
      warnings.push({
        path: `tasks[id=${task.id}].trigger.intervalMs`,
        message: `Task runs very frequently (every ${task.trigger.intervalMs / 1000}s)`,
        severity: 'warning',
        suggestion: 'Consider using longer intervals to reduce resource usage',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a single task object
 */
export function validateTask(task: unknown): ValidationResult {
  const result = ScheduledTaskSchema.safeParse(task);

  if (!result.success) {
    return {
      valid: false,
      errors: zodErrorToIssues(result.error),
      warnings: [],
    };
  }

  // Additional semantic validation for cron
  if (result.data.trigger.type === 'cron') {
    const cronError = validateCronExpression(result.data.trigger.cron);
    if (cronError) {
      return {
        valid: false,
        errors: [{
          path: 'trigger.cron',
          message: cronError,
          severity: 'error',
        }],
        warnings: [],
      };
    }
  }

  return { valid: true, errors: [], warnings: [] };
}

/**
 * Validate create task input
 */
export function validateCreateTaskInput(input: unknown): ValidationResult {
  const result = CreateTaskInputSchema.safeParse(input);

  if (!result.success) {
    return {
      valid: false,
      errors: zodErrorToIssues(result.error),
      warnings: [],
    };
  }

  // Additional semantic validation for cron
  if (result.data.trigger.type === 'cron') {
    const cronError = validateCronExpression(result.data.trigger.cron);
    if (cronError) {
      return {
        valid: false,
        errors: [{
          path: 'trigger.cron',
          message: cronError,
          severity: 'error',
        }],
        warnings: [],
      };
    }
  }

  return { valid: true, errors: [], warnings: [] };
}

/**
 * Validate update task input
 */
export function validateUpdateTaskInput(input: unknown): ValidationResult {
  const result = UpdateTaskInputSchema.safeParse(input);

  if (!result.success) {
    return {
      valid: false,
      errors: zodErrorToIssues(result.error),
      warnings: [],
    };
  }

  // Additional semantic validation for cron if provided
  if (result.data.trigger?.type === 'cron') {
    const cronError = validateCronExpression(result.data.trigger.cron);
    if (cronError) {
      return {
        valid: false,
        errors: [{
          path: 'trigger.cron',
          message: cronError,
          severity: 'error',
        }],
        warnings: [],
      };
    }
  }

  return { valid: true, errors: [], warnings: [] };
}
