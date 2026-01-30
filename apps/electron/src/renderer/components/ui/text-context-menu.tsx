import * as React from "react"
import { useState, useRef, useCallback } from "react"
import { ClipboardPaste, Copy, Scissors, Sparkles } from "lucide-react"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from "./styled-context-menu"
import { cn } from "@/lib/utils"
import type { RephraseResult } from "../../../shared/types"

interface TextSelection {
  text: string
  start: number
  end: number
}

export interface TextContextMenuProps {
  children: React.ReactNode
  /** Get the full text content */
  getText: () => string
  /** Set the full text content */
  setText: (text: string) => void
  /** Get current selection (null if nothing selected) */
  getSelection: () => TextSelection | null
  /** Session ID for rephrase IPC call */
  sessionId: string
  /** Available @mentions (sources/skills) for auto-tagging in rephrase */
  availableMentions?: string[]
  /** Disable the context menu */
  disabled?: boolean
}

/**
 * TextContextMenu — Reusable Radix context menu for text inputs.
 *
 * Replaces the default Electron right-click menu with:
 *   Cut / Copy / Paste  +  Rephrase Selection / Rephrase All
 *
 * Shimmer scoping:
 *   - "Rephrase Selection" → injects a <mark> around the selected DOM range (inline shimmer)
 *   - "Rephrase All" → shimmers the entire wrapper div
 *
 * After replacement, a brief accent glow flash confirms the change.
 */
export function TextContextMenu({
  children,
  getText,
  setText,
  getSelection,
  sessionId,
  availableMentions,
  disabled,
}: TextContextMenuProps) {
  const [rephraseMode, setRephraseMode] = useState<'idle' | 'selection' | 'all'>('idle')
  const [hasSelection, setHasSelection] = useState(false)
  const [isGlowing, setIsGlowing] = useState(false)
  const capturedSelectionRef = useRef<TextSelection | null>(null)
  const capturedTextRef = useRef('')
  const capturedRangeRef = useRef<Range | null>(null)
  const shimmerMarkRef = useRef<HTMLElement | null>(null)

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      capturedSelectionRef.current = getSelection()
      capturedTextRef.current = getText()
      setHasSelection(!!capturedSelectionRef.current?.text)

      // Capture DOM range for inline shimmer (must be done now — selection lost after menu opens)
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        capturedRangeRef.current = sel.getRangeAt(0).cloneRange()
      } else {
        capturedRangeRef.current = null
      }
    }
  }, [getSelection, getText])

  const injectShimmerMark = useCallback(() => {
    const range = capturedRangeRef.current
    if (!range) return false
    try {
      const mark = document.createElement('mark')
      mark.className = 'rephrase-shimmer-inline'
      range.surroundContents(mark)
      shimmerMarkRef.current = mark
      return true
    } catch {
      // Range crosses element boundaries — fall back to wrapper shimmer
      return false
    }
  }, [])

  const removeShimmerMark = useCallback(() => {
    const mark = shimmerMarkRef.current
    if (mark?.parentNode) {
      const parent = mark.parentNode
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
      mark.remove()
    }
    shimmerMarkRef.current = null
  }, [])

  const triggerGlow = useCallback(() => {
    setIsGlowing(true)
    setTimeout(() => setIsGlowing(false), 500)
  }, [])

  const handleCut = useCallback(() => {
    const sel = capturedSelectionRef.current
    const fullText = capturedTextRef.current
    if (sel?.text) {
      navigator.clipboard.writeText(sel.text)
      setText(fullText.slice(0, sel.start) + fullText.slice(sel.end))
    }
  }, [setText])

  const handleCopy = useCallback(() => {
    const sel = capturedSelectionRef.current
    if (sel?.text) {
      navigator.clipboard.writeText(sel.text)
    }
  }, [])

  const handlePaste = useCallback(async () => {
    const clipText = await navigator.clipboard.readText()
    if (!clipText) return
    const sel = capturedSelectionRef.current
    const fullText = capturedTextRef.current
    if (sel) {
      setText(fullText.slice(0, sel.start) + clipText + fullText.slice(sel.end))
    } else {
      setText(fullText + clipText)
    }
  }, [setText])

  const handleRephraseSelection = useCallback(async () => {
    const sel = capturedSelectionRef.current
    if (!sel?.text) return

    // Try inline shimmer on just the selected text; fall back to whole-wrapper shimmer
    const injected = injectShimmerMark()
    setRephraseMode(injected ? 'selection' : 'all')

    try {
      const result = await window.electronAPI.sessionCommand(sessionId, { type: 'rephrase_text', text: sel.text, availableMentions })
      const r = result as RephraseResult | undefined
      removeShimmerMark()
      if (r?.success && r.rephrasedText) {
        const fullText = getText()
        setText(fullText.slice(0, sel.start) + r.rephrasedText + fullText.slice(sel.end))
        toast.success('Selection rephrased')
        triggerGlow()
      } else {
        toast.error(r?.error || 'Failed to rephrase')
      }
    } catch {
      removeShimmerMark()
      toast.error('Failed to rephrase')
    } finally {
      setRephraseMode('idle')
    }
  }, [sessionId, availableMentions, getText, setText, injectShimmerMark, removeShimmerMark, triggerGlow])

  const handleRephraseAll = useCallback(async () => {
    const text = getText()
    if (!text.trim()) return

    setRephraseMode('all')
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, { type: 'rephrase_text', text, availableMentions })
      const r = result as RephraseResult | undefined
      if (r?.success && r.rephrasedText) {
        setText(r.rephrasedText)
        toast.success('Text rephrased')
        triggerGlow()
      } else {
        toast.error(r?.error || 'Failed to rephrase')
      }
    } catch {
      toast.error('Failed to rephrase')
    } finally {
      setRephraseMode('idle')
    }
  }, [sessionId, availableMentions, getText, setText, triggerGlow])

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled}>
        <div className={cn(
          rephraseMode === 'all' && 'animate-shimmer-text',
          isGlowing && 'rephrase-glow',
        )}>
          {children}
        </div>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onSelect={handleCut} disabled={!hasSelection}>
          <Scissors />
          Cut
        </StyledContextMenuItem>
        <StyledContextMenuItem onSelect={handleCopy} disabled={!hasSelection}>
          <Copy />
          Copy
        </StyledContextMenuItem>
        <StyledContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste />
          Paste
        </StyledContextMenuItem>
        <StyledContextMenuSeparator />
        {hasSelection && (
          <StyledContextMenuItem onSelect={handleRephraseSelection} disabled={rephraseMode !== 'idle'}>
            <Sparkles />
            {rephraseMode === 'selection' ? 'Rephrasing...' : 'Rephrase Selection...'}
          </StyledContextMenuItem>
        )}
        <StyledContextMenuItem
          onSelect={handleRephraseAll}
          disabled={rephraseMode !== 'idle' || !capturedTextRef.current.trim()}
        >
          <Sparkles />
          {rephraseMode === 'all' ? 'Rephrasing...' : 'Rephrase All...'}
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}
