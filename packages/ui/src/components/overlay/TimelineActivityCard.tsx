/**
 * TimelineActivityCard - Side-by-side card showing tool input (left) and output (right)
 *
 * Used inside ConversationTimeline to render each tool activity as a compact card.
 * Left panel: tool name badge + JSON tree of input parameters.
 * Right panel: compact inline rendering of the tool output based on type.
 *
 * Cards default to 25vh height. Click the header to expand to full height.
 * Each panel scrolls independently. Outer timeline scrolls when not over a panel.
 *
 * Code output uses a two-column layout: sticky line numbers | scrollable code.
 * Word wrap is a global toggle stored in localStorage.
 */

import { useMemo, useState, useCallback } from 'react'
import JsonView from '@uiw/react-json-view'
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import {
  BookOpen,
  PenLine,
  Terminal,
  Search,
  FolderSearch,
  FileCode,
  Copy,
  Check,
  Globe,
  ChevronDown,
  ChevronRight,
  WrapText,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { extractOverlayData, type OverlayData } from '../../lib/tool-parsers'
import { Markdown } from '../markdown'
import type { ActivityItem } from '../chat/TurnCard'

// ============================================================================
// Word Wrap Preference (global, persisted in localStorage)
// ============================================================================

const WORD_WRAP_KEY = 'craft-timeline-word-wrap'

function getWordWrapPref(): boolean {
  try {
    return localStorage.getItem(WORD_WRAP_KEY) !== 'false'
  } catch {
    return true
  }
}

function setWordWrapPref(value: boolean) {
  try {
    localStorage.setItem(WORD_WRAP_KEY, String(value))
  } catch {
    // ignore
  }
}

// ============================================================================
// Badge Config
// ============================================================================

interface BadgeConfig {
  icon: LucideIcon
  label: string
  variant: 'blue' | 'amber' | 'green' | 'purple' | 'gray'
}

const VARIANT_CLASSES: Record<BadgeConfig['variant'], string> = {
  blue: 'bg-blue-500/10 text-blue-500',
  amber: 'bg-amber-500/10 text-amber-500',
  green: 'bg-green-500/10 text-green-500',
  purple: 'bg-purple-500/10 text-purple-500',
  gray: 'bg-foreground/8 text-muted-foreground',
}

function getToolBadge(toolName: string): BadgeConfig {
  switch (toolName?.toLowerCase()) {
    case 'read':
      return { icon: BookOpen, label: 'Read', variant: 'blue' }
    case 'write':
      return { icon: PenLine, label: 'Write', variant: 'amber' }
    case 'edit':
      return { icon: PenLine, label: 'Edit', variant: 'amber' }
    case 'bash':
      return { icon: Terminal, label: 'Bash', variant: 'gray' }
    case 'grep':
      return { icon: Search, label: 'Grep', variant: 'green' }
    case 'glob':
      return { icon: FolderSearch, label: 'Glob', variant: 'purple' }
    case 'websearch':
      return { icon: Globe, label: 'WebSearch', variant: 'blue' }
    case 'webfetch':
      return { icon: Globe, label: 'WebFetch', variant: 'blue' }
    case 'notebookedit':
      return { icon: PenLine, label: 'NotebookEdit', variant: 'amber' }
    default:
      return { icon: FileCode, label: toolName || 'Tool', variant: 'gray' }
  }
}

// ============================================================================
// JSON Themes
// ============================================================================

const darkJsonTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const lightJsonTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

// ============================================================================
// cat -n Content Parser
// ============================================================================

interface ParsedLine {
  lineNumber: string
  content: string
}

/**
 * Parse content in `cat -n` format into separate line numbers and code.
 * Format: "     1→\tcontent" or "     1\tcontent"
 * Returns null if content doesn't look like cat -n format.
 */
function parseCatNContent(content: string): ParsedLine[] | null {
  const lines = content.split('\n')
  if (lines.length < 2) return null

  // Check if first few lines match cat -n format: spaces + number + tab/arrow
  const catNPattern = /^\s*(\d+)[→\t]/
  let matches = 0
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (catNPattern.test(lines[i]!)) matches++
  }

  // Need most lines to match
  if (matches < Math.min(lines.length, 3)) return null

  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)[→\t](.*)$/)
    if (match) {
      return { lineNumber: match[1]!, content: match[2]! }
    }
    return { lineNumber: '', content: line }
  })
}

// ============================================================================
// Code Viewer (two-column: line numbers | code)
// ============================================================================

function TimelineCodeViewer({
  content,
  wordWrap,
}: {
  content: string
  wordWrap: boolean
}) {
  const parsedLines = useMemo(() => parseCatNContent(content), [content])

  if (!parsedLines) {
    // Not cat -n format — render as plain pre
    return (
      <pre
        className={cn(
          'p-3 font-mono text-xs text-foreground/90',
          wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
        )}
      >
        {content}
      </pre>
    )
  }

  return (
    <table className="w-full border-collapse font-mono text-xs">
      <tbody>
        {parsedLines.map((line, i) => (
          <tr key={i} className="leading-relaxed">
            <td className="sticky left-0 select-none text-right pr-3 pl-2 text-muted-foreground/40 bg-background/80 w-[1px]">
              {line.lineNumber}
            </td>
            <td
              className={cn(
                'text-foreground/90',
                wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
              )}
            >
              {line.content}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ============================================================================
// Output Renderer
// ============================================================================

export interface TimelineActivityCardProps {
  activity: ActivityItem
  isFocused: boolean
  theme?: 'light' | 'dark'
  wordWrap: boolean
  onToggleWordWrap: () => void
}

function OutputRenderer({
  overlayData,
  theme,
  wordWrap,
}: {
  overlayData: OverlayData | null
  theme: 'light' | 'dark'
  wordWrap: boolean
}) {
  const jsonTheme = useMemo(() => (theme === 'dark' ? darkJsonTheme : lightJsonTheme), [theme])

  if (!overlayData) {
    return <div className="text-xs text-muted-foreground italic p-3">No output</div>
  }

  switch (overlayData.type) {
    case 'code':
      return <TimelineCodeViewer content={overlayData.content} wordWrap={wordWrap} />

    case 'terminal':
      return (
        <div className="p-3 font-mono text-xs">
          {overlayData.command && (
            <div className="mb-2">
              <span className="text-muted-foreground">$ </span>
              <span className={cn('text-foreground', wordWrap ? 'break-words' : '')}>{overlayData.command}</span>
            </div>
          )}
          <pre className={cn(wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre', 'text-foreground/80')}>
            {overlayData.output}
          </pre>
        </div>
      )

    case 'json':
      return (
        <div className="p-3">
          <JsonView
            value={overlayData.data as object}
            style={jsonTheme}
            collapsed={2}
            enableClipboard={true}
            displayDataTypes={false}
            shortenTextAfterLength={100}
          >
            <JsonView.Copied
              render={(props) => {
                const isCopied = (props as Record<string, unknown>)['data-copied']
                return isCopied ? (
                  <Check className="ml-1.5 inline-flex cursor-pointer text-green-500" size={10} onClick={props.onClick} />
                ) : (
                  <Copy className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground" size={10} onClick={props.onClick} />
                )
              }}
            />
          </JsonView>
        </div>
      )

    case 'document':
      return (
        <div className="p-3">
          <div className="text-sm">
            <Markdown mode="minimal">{overlayData.content}</Markdown>
          </div>
        </div>
      )

    case 'generic':
      return <TimelineCodeViewer content={overlayData.content} wordWrap={wordWrap} />

    default:
      return <div className="text-xs text-muted-foreground italic p-3">Unknown output type</div>
  }
}

// ============================================================================
// Main Component
// ============================================================================

export function TimelineActivityCard({ activity, isFocused, theme = 'dark', wordWrap, onToggleWordWrap }: TimelineActivityCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const badge = useMemo(() => getToolBadge(activity.toolName || ''), [activity.toolName])
  const BadgeIcon = badge.icon
  const overlayData = useMemo(() => extractOverlayData(activity), [activity])
  const jsonTheme = useMemo(() => (theme === 'dark' ? darkJsonTheme : lightJsonTheme), [theme])
  const toolInput = activity.toolInput as Record<string, unknown> | undefined

  const displayName = activity.displayName || activity.intent || ''

  return (
    <div
      className={cn(
        'rounded-xl border bg-background/80 backdrop-blur-sm overflow-hidden transition-all',
        isFocused
          ? 'ring-2 ring-accent border-accent/30 shadow-lg'
          : 'border-foreground/[0.08] shadow-sm hover:border-foreground/[0.15]'
      )}
    >
      {/* Card header — click to expand/collapse */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-foreground/[0.06] bg-foreground/[0.02]">
        <div
          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer select-none hover:opacity-80 transition-opacity"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          )}
          <div className={cn('flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium', VARIANT_CLASSES[badge.variant])}>
            <BadgeIcon className="h-3 w-3" />
            {badge.label}
          </div>
          {displayName && (
            <span className="text-xs text-muted-foreground truncate">{displayName}</span>
          )}
          {activity.error && (
            <span className="text-xs text-red-500 font-medium ml-auto">Error</span>
          )}
        </div>
        {/* Word wrap toggle */}
        <button
          className={cn(
            'shrink-0 p-1 rounded transition-colors',
            wordWrap
              ? 'text-accent bg-accent/10'
              : 'text-muted-foreground/40 hover:text-muted-foreground'
          )}
          onClick={(e) => {
            e.stopPropagation()
            onToggleWordWrap()
          }}
          title={wordWrap ? 'Word wrap: ON' : 'Word wrap: OFF'}
        >
          <WrapText className="h-3 w-3" />
        </button>
      </div>

      {/* Side-by-side: Input (left) | Output (right) */}
      <div
        className="grid grid-cols-2 divide-x divide-foreground/[0.06] overflow-hidden"
        style={{ height: isExpanded ? '80vh' : '25vh' }}
      >
        {/* Left: Input parameters */}
        <div className="overflow-y-auto p-3 h-full">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-2">Input</div>
          {toolInput && Object.keys(toolInput).length > 0 ? (
            <JsonView
              value={toolInput}
              style={jsonTheme}
              collapsed={false}
              enableClipboard={true}
              displayDataTypes={false}
              shortenTextAfterLength={150}
            >
              <JsonView.Copied
                render={(props) => {
                  const isCopied = (props as Record<string, unknown>)['data-copied']
                  return isCopied ? (
                    <Check className="ml-1.5 inline-flex cursor-pointer text-green-500" size={10} onClick={props.onClick} />
                  ) : (
                    <Copy className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground" size={10} onClick={props.onClick} />
                  )
                }}
              />
            </JsonView>
          ) : (
            <div className="text-xs text-muted-foreground italic">No input parameters</div>
          )}
        </div>

        {/* Right: Output */}
        <div className={cn('overflow-y-auto h-full', !wordWrap && 'overflow-x-auto')}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold px-3 pt-3 pb-1">Output</div>
          <OutputRenderer overlayData={overlayData} theme={theme} wordWrap={wordWrap} />
        </div>
      </div>

      {/* Error banner */}
      {activity.error && (
        <div className="px-3 py-2 bg-red-500/5 border-t border-red-500/10">
          <div className="text-xs text-red-500">{activity.error}</div>
        </div>
      )}
    </div>
  )
}

// Re-export for ConversationTimeline to use
export { getWordWrapPref, setWordWrapPref }
