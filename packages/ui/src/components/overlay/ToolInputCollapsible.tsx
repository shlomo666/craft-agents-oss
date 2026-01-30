/**
 * ToolInputCollapsible - Collapsible section showing tool input parameters
 *
 * Renders an expandable JSON tree of the tool's input parameters.
 * Collapsed by default to keep existing overlay UX clean.
 * Uses @uiw/react-json-view for interactive expand/collapse tree navigation.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import JsonView from '@uiw/react-json-view'
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { ChevronRight, Copy, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'

const darkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const lightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

export interface ToolInputCollapsibleProps {
  /** The tool input parameters to display */
  toolInput: Record<string, unknown>
  /** Theme mode */
  theme?: 'light' | 'dark'
}

export function ToolInputCollapsible({ toolInput, theme = 'dark' }: ToolInputCollapsibleProps) {
  const [isOpen, setIsOpen] = useState(false)
  const jsonTheme = useMemo(() => (theme === 'dark' ? darkTheme : lightTheme), [theme])

  const paramCount = Object.keys(toolInput).length

  return (
    <div className="px-4 pb-2">
      <div className="rounded-lg border border-foreground/[0.06] bg-foreground/[0.03] overflow-hidden">
        {/* Toggle header */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <motion.div
            initial={false}
            animate={{ rotate: isOpen ? 90 : 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          >
            <ChevronRight className="h-3 w-3" />
          </motion.div>
          <span className="font-medium">Input Parameters</span>
          <span className="text-muted-foreground/60">({paramCount})</span>
        </button>

        {/* Collapsible content */}
        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3 border-t border-foreground/[0.06]">
                <div className="pt-2">
                  <JsonView
                    value={toolInput}
                    style={jsonTheme}
                    collapsed={false}
                    enableClipboard={true}
                    displayDataTypes={false}
                    shortenTextAfterLength={200}
                  >
                    <JsonView.Copied
                      render={(props) => {
                        const isCopied = (props as Record<string, unknown>)['data-copied']
                        return isCopied ? (
                          <Check
                            className="ml-1.5 inline-flex cursor-pointer text-green-500"
                            size={10}
                            onClick={props.onClick}
                          />
                        ) : (
                          <Copy
                            className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground"
                            size={10}
                            onClick={props.onClick}
                          />
                        )
                      }}
                    />
                  </JsonView>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
