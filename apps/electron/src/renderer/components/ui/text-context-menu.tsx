import * as React from "react"
import { useState, useRef, useCallback } from "react"
import { Clipboard, ClipboardPaste, Copy, Scissors, Sparkles } from "lucide-react"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from "./styled-context-menu"
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
 * Works with both <textarea> and contenteditable elements.
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
  const [isRephrasing, setIsRephrasing] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)
  const capturedSelectionRef = useRef<TextSelection | null>(null)
  const capturedTextRef = useRef('')

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      capturedSelectionRef.current = getSelection()
      capturedTextRef.current = getText()
      setHasSelection(!!capturedSelectionRef.current?.text)
    }
  }, [getSelection, getText])

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
      // No selection — append at end
      setText(fullText + clipText)
    }
  }, [setText])

  const handleRephraseSelection = useCallback(async () => {
    const sel = capturedSelectionRef.current
    if (!sel?.text) return

    setIsRephrasing(true)
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, { type: 'rephrase_text', text: sel.text, availableMentions })
      const r = result as RephraseResult | undefined
      if (r?.success && r.rephrasedText) {
        const fullText = getText()
        setText(fullText.slice(0, sel.start) + r.rephrasedText + fullText.slice(sel.end))
        toast.success('Selection rephrased')
      } else {
        toast.error(r?.error || 'Failed to rephrase')
      }
    } catch {
      toast.error('Failed to rephrase')
    } finally {
      setIsRephrasing(false)
    }
  }, [sessionId, availableMentions, getText, setText])

  const handleRephraseAll = useCallback(async () => {
    const text = getText()
    if (!text.trim()) return

    setIsRephrasing(true)
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, { type: 'rephrase_text', text, availableMentions })
      const r = result as RephraseResult | undefined
      if (r?.success && r.rephrasedText) {
        setText(r.rephrasedText)
        toast.success('Text rephrased')
      } else {
        toast.error(r?.error || 'Failed to rephrase')
      }
    } catch {
      toast.error('Failed to rephrase')
    } finally {
      setIsRephrasing(false)
    }
  }, [sessionId, availableMentions, getText, setText])

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled}>
        <div className={isRephrasing ? 'animate-shimmer-text' : undefined}>
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
          <StyledContextMenuItem onSelect={handleRephraseSelection} disabled={isRephrasing}>
            <Sparkles />
            {isRephrasing ? 'Rephrasing...' : 'Rephrase Selection...'}
          </StyledContextMenuItem>
        )}
        <StyledContextMenuItem
          onSelect={handleRephraseAll}
          disabled={isRephrasing || !capturedTextRef.current.trim()}
        >
          <Sparkles />
          {isRephrasing ? 'Rephrasing...' : 'Rephrase All...'}
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}
