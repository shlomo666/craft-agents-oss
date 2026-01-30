/**
 * ConversationTimeline - Fullscreen overlay showing all tool activities in a scrollable timeline
 *
 * When the user clicks any tool result, this overlay opens showing ALL tool activities
 * from the conversation in a vertical scrollable list. Each activity is rendered as a
 * side-by-side card (input left, output right) via TimelineActivityCard.
 *
 * The clicked activity is auto-scrolled into view and highlighted.
 * Arrow keys navigate between activities. Escape closes the overlay.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { FullscreenOverlayBase } from './FullscreenOverlayBase'
import { TimelineActivityCard } from './TimelineActivityCard'
import type { ActivityItem } from '../chat/TurnCard'

export interface ConversationTimelineProps {
  activities: ActivityItem[]
  focusedActivityId: string
  isOpen: boolean
  onClose: () => void
  theme?: 'light' | 'dark'
}

export function ConversationTimeline({
  activities,
  focusedActivityId,
  isOpen,
  onClose,
  theme = 'dark',
}: ConversationTimelineProps) {
  const [currentFocusId, setCurrentFocusId] = useState(focusedActivityId)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const hasScrolledRef = useRef(false)

  // Reset focus when the overlay opens with a new focused activity
  useEffect(() => {
    setCurrentFocusId(focusedActivityId)
    hasScrolledRef.current = false
  }, [focusedActivityId])

  // Scroll the focused activity into view after mount/render
  useEffect(() => {
    if (!isOpen || hasScrolledRef.current) return

    // Small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      const el = cardRefs.current.get(currentFocusId)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        hasScrolledRef.current = true
      }
    }, 100)

    return () => clearTimeout(timer)
  }, [isOpen, currentFocusId])

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return

      const currentIndex = activities.findIndex((a) => a.id === currentFocusId)
      if (currentIndex === -1) return

      let nextIndex: number | null = null

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        nextIndex = Math.min(currentIndex + 1, activities.length - 1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        nextIndex = Math.max(currentIndex - 1, 0)
      }

      if (nextIndex !== null && nextIndex !== currentIndex) {
        const nextActivity = activities[nextIndex]
        if (nextActivity) {
          setCurrentFocusId(nextActivity.id)
          const el = cardRefs.current.get(nextActivity.id)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }
      }
    },
    [isOpen, activities, currentFocusId]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const setCardRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      cardRefs.current.set(id, el)
    } else {
      cardRefs.current.delete(id)
    }
  }, [])

  return (
    <FullscreenOverlayBase
      isOpen={isOpen}
      onClose={onClose}
      title="Conversation Timeline"
      accessibleTitle="Conversation Timeline"
    >
      <div className="flex flex-col gap-4 px-6 pb-32 max-w-[1400px] mx-auto w-full">
        {/* Activity count */}
        <div className="text-xs text-muted-foreground/50 text-center">
          {activities.length} tool {activities.length === 1 ? 'call' : 'calls'}
        </div>

        {activities.map((activity, index) => (
          <div
            key={activity.id}
            ref={(el) => setCardRef(activity.id, el)}
          >
            {/* Step number */}
            <div className="text-[10px] text-muted-foreground/40 font-mono mb-1 pl-1">
              #{index + 1}
            </div>
            <TimelineActivityCard
              activity={activity}
              isFocused={activity.id === currentFocusId}
              theme={theme}
            />
          </div>
        ))}
      </div>
    </FullscreenOverlayBase>
  )
}
