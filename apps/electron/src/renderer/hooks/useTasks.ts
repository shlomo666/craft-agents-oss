/**
 * useTasks Hook
 *
 * React hook to load and manage scheduled tasks.
 * Auto-refreshes when workspace changes or tasks are modified.
 */

import { useState, useEffect, useCallback } from 'react'
import type { TaskWithState, TaskSchedulerEvent } from '../../shared/types'

export interface UseTasksResult {
  tasks: TaskWithState[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Load tasks for a workspace via IPC
 * Auto-refreshes when workspaceId changes or tasks are modified
 */
export function useTasks(workspaceId: string | null): UseTasksResult {
  const [tasks, setTasks] = useState<TaskWithState[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setTasks([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const loadedTasks = await window.electronAPI.tasksList(workspaceId)
      setTasks(loadedTasks)
      setError(null)
    } catch (err) {
      console.error('[useTasks] Failed to load tasks:', err)
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // Load tasks when workspace changes
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to live task changes (config changes)
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onTasksChanged(() => {
      refresh()
    })

    return cleanup
  }, [workspaceId, refresh])

  return {
    tasks,
    isLoading,
    error,
    refresh,
  }
}

export interface UseTaskEventsResult {
  lastEvent: TaskSchedulerEvent | null
}

/**
 * Subscribe to task execution events (started, completed, error, progress)
 */
export function useTaskEvents(): UseTaskEventsResult {
  const [lastEvent, setLastEvent] = useState<TaskSchedulerEvent | null>(null)

  useEffect(() => {
    const cleanup = window.electronAPI.onTaskEvent((event) => {
      setLastEvent(event)
    })

    return cleanup
  }, [])

  return { lastEvent }
}
