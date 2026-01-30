/**
 * ConversationTimeline - Fullscreen overlay showing all tool activities in a scrollable timeline
 *
 * When the user clicks any tool result, this overlay opens showing ALL tool activities
 * from the current turn in a vertical scrollable list. Each activity is rendered as a
 * side-by-side card (input left, output right) via TimelineActivityCard.
 *
 * Agent text responses are shown between tool cards as plain text blocks.
 *
 * The clicked activity is auto-scrolled into view and highlighted.
 * Arrow keys navigate between activities. Escape closes the overlay.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { cn } from '../../lib/utils'
import { FullscreenOverlayBase } from './FullscreenOverlayBase'
import { TimelineActivityCard, getWordWrapPref, setWordWrapPref } from './TimelineActivityCard'
import { Markdown } from '../markdown'
import type { ActivityItem } from '../chat/TurnCard'

/**
 * Inline style tag for the focus glow animation.
 * A blue ring that fades out over 600ms.
 */
const GLOW_STYLE = `
@keyframes timeline-focus-glow {
  0% { box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.6); }
  100% { box-shadow: 0 0 0 2px rgba(59, 130, 246, 0); }
}
.timeline-focus-glow {
  animation: timeline-focus-glow 1000ms ease-out forwards;
  border-radius: 12px;
}
`

/** A timeline entry is either a tool activity card or an agent text block */
export type TimelineEntry =
  | { type: 'tool'; activity: ActivityItem }
  | { type: 'text'; id: string; content: string }

export interface ConversationTimelineProps {
  entries: TimelineEntry[]
  focusedActivityId: string
  isOpen: boolean
  onClose: () => void
  theme?: 'light' | 'dark'
}

export function ConversationTimeline({
  entries,
  focusedActivityId,
  isOpen,
  onClose,
  theme = 'dark',
}: ConversationTimelineProps) {
  const [currentFocusId, setCurrentFocusId] = useState(focusedActivityId)
  const [wordWrap, setWordWrap] = useState(getWordWrapPref)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const hasScrolledRef = useRef(false)

  // All tool entries for keyboard navigation
  const toolEntries = entries.filter((e): e is { type: 'tool'; activity: ActivityItem } => e.type === 'tool')

  const toggleWordWrap = useCallback(() => {
    setWordWrap((prev) => {
      const next = !prev
      setWordWrapPref(next)
      return next
    })
  }, [])

  // Reset focus when the overlay opens with a new focused activity
  useEffect(() => {
    setCurrentFocusId(focusedActivityId)
    hasScrolledRef.current = false
  }, [focusedActivityId])

  // Scroll the focused activity into view instantly on mount
  useEffect(() => {
    if (!isOpen || hasScrolledRef.current) return

    // Use requestAnimationFrame to ensure DOM is painted
    const raf = requestAnimationFrame(() => {
      const el = cardRefs.current.get(currentFocusId)
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        hasScrolledRef.current = true
      }
    })

    return () => cancelAnimationFrame(raf)
  }, [isOpen, currentFocusId])

  // Keyboard navigation (only through tool entries)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return

      const currentIndex = toolEntries.findIndex((t) => t.activity.id === currentFocusId)
      if (currentIndex === -1) return

      let nextIndex: number | null = null

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        nextIndex = Math.min(currentIndex + 1, toolEntries.length - 1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        nextIndex = Math.max(currentIndex - 1, 0)
      }

      if (nextIndex !== null && nextIndex !== currentIndex) {
        const nextEntry = toolEntries[nextIndex]
        if (nextEntry) {
          setCurrentFocusId(nextEntry.activity.id)
          const el = cardRefs.current.get(nextEntry.activity.id)
          if (el) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' })
          }
        }
      }
    },
    [isOpen, toolEntries, currentFocusId]
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

  // Track tool step numbers
  let toolStepNumber = 0

  return (
    <FullscreenOverlayBase
      isOpen={isOpen}
      onClose={onClose}
      title="Conversation Timeline"
      accessibleTitle="Conversation Timeline"
    >
      {/* Inject glow animation styles */}
      <style dangerouslySetInnerHTML={{ __html: GLOW_STYLE }} />
      <div className="flex flex-col gap-4 px-6 pb-32 max-w-[1400px] mx-auto w-full">
        {/* Activity count */}
        <div className="text-xs text-muted-foreground/50 text-center">
          {toolEntries.length} tool {toolEntries.length === 1 ? 'call' : 'calls'}
        </div>

        {entries.map((entry) => {
          if (entry.type === 'text') {
            const isTextFocused = entry.id === currentFocusId
            return (
              <div
                key={entry.id}
                ref={(el) => setCardRef(entry.id, el)}
                className={cn(
                  'px-3 py-2 text-sm text-foreground rounded-xl',
                  isTextFocused && 'timeline-focus-glow'
                )}
              >
                <Markdown mode="minimal">{entry.content}</Markdown>
              </div>
            )
          }

          toolStepNumber++
          const activity = entry.activity
          const isToolFocused = activity.id === currentFocusId
          return (
            <div
              key={activity.id}
              ref={(el) => setCardRef(activity.id, el)}
              className={cn(isToolFocused && 'timeline-focus-glow')}
            >
              <div className="text-[10px] text-muted-foreground/40 font-mono mb-1 pl-1">
                #{toolStepNumber}
              </div>
              <TimelineActivityCard
                activity={activity}
                isFocused={activity.id === currentFocusId}
                theme={theme}
                wordWrap={wordWrap}
                onToggleWordWrap={toggleWordWrap}
              />
            </div>
          )
        })}
      </div>
    </FullscreenOverlayBase>
  )
}
