/**
 * Task Storage
 *
 * Filesystem-based storage for scheduled tasks.
 *
 * Storage structure:
 * - Workspace-scoped tasks: {workspaceRootPath}/tasks/config.json
 * - Workspace task state: {workspaceRootPath}/tasks/state.json
 * - Global tasks: ~/.craft-agent/tasks/config.json
 * - Global task state: ~/.craft-agent/tasks/state.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  WorkspaceTaskConfig,
  ScheduledTask,
  TasksStateFile,
  TaskState,
  TaskResult,
  TaskRun,
  CreateTaskInput,
  UpdateTaskInput,
} from './types.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { debug } from '../utils/debug.ts';

const TASKS_DIR = 'tasks';
const TASKS_CONFIG_FILE = 'tasks/config.json';
const TASKS_STATE_FILE = 'tasks/state.json';
const MAX_RUN_HISTORY = 10;

// ============================================================
// Configuration Storage
// ============================================================

/**
 * Get default task configuration (empty, no tasks)
 */
export function getDefaultTaskConfig(): WorkspaceTaskConfig {
  return {
    version: 1,
    tasks: [],
  };
}

/**
 * Get the tasks directory path for a workspace
 */
export function getTasksDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, TASKS_DIR);
}

/**
 * Get the tasks config file path for a workspace
 */
export function getTasksConfigPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, TASKS_CONFIG_FILE);
}

/**
 * Get the tasks state file path for a workspace
 */
export function getTasksStatePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, TASKS_STATE_FILE);
}

/**
 * Get global tasks directory path
 */
export function getGlobalTasksDir(): string {
  return join(CONFIG_DIR, TASKS_DIR);
}

/**
 * Get global tasks config file path
 */
export function getGlobalTasksConfigPath(): string {
  return join(CONFIG_DIR, TASKS_CONFIG_FILE);
}

/**
 * Get global tasks state file path
 */
export function getGlobalTasksStatePath(): string {
  return join(CONFIG_DIR, TASKS_STATE_FILE);
}

/**
 * Ensure tasks directory exists
 */
export function ensureTasksDir(workspaceRootPath: string): void {
  const tasksDir = getTasksDir(workspaceRootPath);
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }
}

/**
 * Load workspace task configuration
 * Returns empty config if none exists
 */
export function loadTaskConfig(workspaceRootPath: string): WorkspaceTaskConfig {
  const configPath = getTasksConfigPath(workspaceRootPath);

  if (!existsSync(configPath)) {
    return getDefaultTaskConfig();
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as WorkspaceTaskConfig;
    return config;
  } catch (error) {
    debug('[loadTaskConfig] Failed to parse config:', error);
    return getDefaultTaskConfig();
  }
}

/**
 * Save workspace task configuration to disk
 */
export function saveTaskConfig(
  workspaceRootPath: string,
  config: WorkspaceTaskConfig
): void {
  ensureTasksDir(workspaceRootPath);
  const configPath = getTasksConfigPath(workspaceRootPath);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveTaskConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * Load global task configuration
 */
export function loadGlobalTaskConfig(): WorkspaceTaskConfig {
  const configPath = getGlobalTasksConfigPath();

  if (!existsSync(configPath)) {
    return getDefaultTaskConfig();
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as WorkspaceTaskConfig;
    return config;
  } catch (error) {
    debug('[loadGlobalTaskConfig] Failed to parse config:', error);
    return getDefaultTaskConfig();
  }
}

/**
 * Save global task configuration
 */
export function saveGlobalTaskConfig(config: WorkspaceTaskConfig): void {
  const tasksDir = getGlobalTasksDir();
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  const configPath = getGlobalTasksConfigPath();
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveGlobalTaskConfig] Failed to save config:', error);
    throw error;
  }
}

// ============================================================
// State Storage
// ============================================================

/**
 * Get default task state file (empty)
 */
export function getDefaultTaskStateFile(): TasksStateFile {
  return {
    version: 1,
    tasks: {},
  };
}

/**
 * Load workspace task state
 */
export function loadTaskState(workspaceRootPath: string): TasksStateFile {
  const statePath = getTasksStatePath(workspaceRootPath);

  if (!existsSync(statePath)) {
    return getDefaultTaskStateFile();
  }

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as TasksStateFile;
    return state;
  } catch (error) {
    debug('[loadTaskState] Failed to parse state:', error);
    return getDefaultTaskStateFile();
  }
}

/**
 * Save workspace task state to disk
 */
export function saveTaskState(
  workspaceRootPath: string,
  state: TasksStateFile
): void {
  ensureTasksDir(workspaceRootPath);
  const statePath = getTasksStatePath(workspaceRootPath);

  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveTaskState] Failed to save state:', error);
    throw error;
  }
}

/**
 * Load global task state
 */
export function loadGlobalTaskState(): TasksStateFile {
  const statePath = getGlobalTasksStatePath();

  if (!existsSync(statePath)) {
    return getDefaultTaskStateFile();
  }

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as TasksStateFile;
    return state;
  } catch (error) {
    debug('[loadGlobalTaskState] Failed to parse state:', error);
    return getDefaultTaskStateFile();
  }
}

/**
 * Save global task state
 */
export function saveGlobalTaskState(state: TasksStateFile): void {
  const tasksDir = getGlobalTasksDir();
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  const statePath = getGlobalTasksStatePath();
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveGlobalTaskState] Failed to save state:', error);
    throw error;
  }
}

// ============================================================
// CRUD Operations
// ============================================================

/**
 * Get a single task by ID
 */
export function getTask(
  workspaceRootPath: string,
  taskId: string
): ScheduledTask | null {
  const config = loadTaskConfig(workspaceRootPath);
  return config.tasks.find(t => t.id === taskId) || null;
}

/**
 * List all tasks for a workspace
 */
export function listTasks(workspaceRootPath: string): ScheduledTask[] {
  const config = loadTaskConfig(workspaceRootPath);
  return config.tasks;
}

/**
 * Create a new task
 */
export function createTask(
  workspaceRootPath: string,
  input: CreateTaskInput
): ScheduledTask {
  const config = loadTaskConfig(workspaceRootPath);
  const now = new Date().toISOString();

  const task: ScheduledTask = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    trigger: input.trigger,
    action: input.action,
    scope: input.scope ?? {},
  };

  config.tasks.push(task);
  saveTaskConfig(workspaceRootPath, config);

  return task;
}

/**
 * Update an existing task
 */
export function updateTask(
  workspaceRootPath: string,
  taskId: string,
  input: UpdateTaskInput
): ScheduledTask | null {
  const config = loadTaskConfig(workspaceRootPath);
  const taskIndex = config.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return null;
  }

  const task = config.tasks[taskIndex]!;
  const now = new Date().toISOString();

  const updatedTask: ScheduledTask = {
    id: task.id,
    name: input.name ?? task.name,
    description: input.description ?? task.description,
    enabled: input.enabled ?? task.enabled,
    createdAt: task.createdAt,
    updatedAt: now,
    trigger: input.trigger ?? task.trigger,
    action: input.action ?? task.action,
    scope: input.scope ?? task.scope,
  };

  config.tasks[taskIndex] = updatedTask;
  saveTaskConfig(workspaceRootPath, config);

  return updatedTask;
}

/**
 * Delete a task
 */
export function deleteTask(
  workspaceRootPath: string,
  taskId: string
): boolean {
  const config = loadTaskConfig(workspaceRootPath);
  const taskIndex = config.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return false;
  }

  config.tasks.splice(taskIndex, 1);
  saveTaskConfig(workspaceRootPath, config);

  // Also remove task state
  const state = loadTaskState(workspaceRootPath);
  delete state.tasks[taskId];
  saveTaskState(workspaceRootPath, state);

  return true;
}

/**
 * Toggle task enabled state
 */
export function toggleTask(
  workspaceRootPath: string,
  taskId: string,
  enabled: boolean
): ScheduledTask | null {
  return updateTask(workspaceRootPath, taskId, { enabled });
}

// ============================================================
// State Operations
// ============================================================

/**
 * Get state for a single task
 */
export function getTaskState(
  workspaceRootPath: string,
  taskId: string
): TaskState | null {
  const stateFile = loadTaskState(workspaceRootPath);
  return stateFile.tasks[taskId] || null;
}

/**
 * Mark task as running
 */
export function markTaskRunning(
  workspaceRootPath: string,
  taskId: string
): void {
  const stateFile = loadTaskState(workspaceRootPath);

  if (!stateFile.tasks[taskId]) {
    stateFile.tasks[taskId] = { taskId };
  }

  stateFile.tasks[taskId].isRunning = true;
  saveTaskState(workspaceRootPath, stateFile);
}

/**
 * Record task run completion
 */
export function recordTaskRun(
  workspaceRootPath: string,
  taskId: string,
  run: TaskRun
): void {
  const stateFile = loadTaskState(workspaceRootPath);

  if (!stateFile.tasks[taskId]) {
    stateFile.tasks[taskId] = { taskId };
  }

  const taskState = stateFile.tasks[taskId];
  taskState.isRunning = false;
  taskState.lastRun = run.result.completedAt;
  taskState.lastResult = run.result;

  // Add to run history, keeping only MAX_RUN_HISTORY entries
  if (!taskState.runHistory) {
    taskState.runHistory = [];
  }
  taskState.runHistory.unshift(run);
  if (taskState.runHistory.length > MAX_RUN_HISTORY) {
    taskState.runHistory = taskState.runHistory.slice(0, MAX_RUN_HISTORY);
  }

  saveTaskState(workspaceRootPath, stateFile);
}

/**
 * Update next scheduled run time
 */
export function updateNextRun(
  workspaceRootPath: string,
  taskId: string,
  nextRun: string
): void {
  const stateFile = loadTaskState(workspaceRootPath);

  if (!stateFile.tasks[taskId]) {
    stateFile.tasks[taskId] = { taskId };
  }

  stateFile.tasks[taskId].nextRun = nextRun;
  saveTaskState(workspaceRootPath, stateFile);
}

// ============================================================
// Bulk Operations
// ============================================================

/**
 * Load all tasks with their state merged (for UI display)
 */
export function listTasksWithState(workspaceRootPath: string): Array<ScheduledTask & { state: TaskState }> {
  const config = loadTaskConfig(workspaceRootPath);
  const stateFile = loadTaskState(workspaceRootPath);

  return config.tasks.map(task => ({
    ...task,
    state: stateFile.tasks[task.id] || { taskId: task.id },
  }));
}

/**
 * Get all enabled tasks for a workspace
 */
export function listEnabledTasks(workspaceRootPath: string): ScheduledTask[] {
  const config = loadTaskConfig(workspaceRootPath);
  return config.tasks.filter(t => t.enabled);
}

/**
 * Check if a task ID exists
 */
export function isValidTaskId(
  workspaceRootPath: string,
  taskId: string
): boolean {
  const config = loadTaskConfig(workspaceRootPath);
  return config.tasks.some(t => t.id === taskId);
}
