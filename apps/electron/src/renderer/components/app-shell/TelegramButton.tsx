/**
 * TelegramButton — Sidebar button for Telegram bot setup and status
 *
 * Three states:
 * 1. No token: Click opens popover with token input
 * 2. Running: Green dot, popover shows status + stop/remove options
 * 3. Stopped/Error: Yellow/red dot, popover shows start option
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { Send, Eye, EyeOff, Power, PowerOff, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { TelegramStatusInfo } from '../../../shared/types'

export function TelegramButton() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<TelegramStatusInfo>({
    running: false,
    botUsername: null,
    hasToken: false,
    error: null,
  })
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)

  // Fetch initial status
  useEffect(() => {
    window.electronAPI.telegramGetStatus().then(setStatus)
  }, [])

  // Listen for status changes
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTelegramStatusChanged(setStatus)
    return unsubscribe
  }, [])

  const handleSaveToken = useCallback(async () => {
    if (!tokenInput.trim()) return
    setLoading(true)
    try {
      const newStatus = await window.electronAPI.telegramSetToken(tokenInput.trim())
      setStatus(newStatus)
      setTokenInput('')
      if (newStatus.running) {
        setOpen(false)
      }
    } finally {
      setLoading(false)
    }
  }, [tokenInput])

  const handleStart = useCallback(async () => {
    setLoading(true)
    try {
      const newStatus = await window.electronAPI.telegramStart()
      setStatus(newStatus)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleStop = useCallback(async () => {
    setLoading(true)
    try {
      await window.electronAPI.telegramStop()
      const newStatus = await window.electronAPI.telegramGetStatus()
      setStatus(newStatus)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleReset = useCallback(async () => {
    setLoading(true)
    try {
      const newStatus = await window.electronAPI.telegramClearToken()
      setStatus(newStatus)
    } finally {
      setLoading(false)
    }
  }, [])

  const statusDotColor = status.running
    ? 'bg-success'
    : status.hasToken
      ? status.error ? 'bg-destructive' : 'bg-foreground/40'
      : 'bg-transparent'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 py-[7px] px-2 text-[13px] font-normal rounded-[6px]"
        >
          <TelegramIcon className="h-3.5 w-3.5 shrink-0" />
          Telegram
          {status.hasToken && (
            <span className="ml-auto relative inline-flex shrink-0">
              {status.running && (
                <span
                  className="absolute inline-flex rounded-full opacity-75 animate-ping bg-success h-1.5 w-1.5"
                  style={{ animationDuration: '2s' }}
                />
              )}
              <span className={cn('relative inline-flex rounded-full h-1.5 w-1.5', statusDotColor)} />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 p-3"
      >
        {!status.hasToken ? (
          // No token — show input
          <div className="space-y-3">
            <div className="text-xs font-medium text-foreground/70">Connect your Telegram bot</div>
            <div className="relative rounded-md bg-muted/50 has-[:focus-visible]:bg-background">
              <Input
                type={showToken ? 'text' : 'password'}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Bot token from @BotFather"
                className="pr-10 bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:outline-none text-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveToken()
                }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleSaveToken}
              disabled={!tokenInput.trim() || loading}
              className="w-full text-xs"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Connect Bot
            </Button>
          </div>
        ) : (
          // Token exists — show status
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={cn(
                'relative inline-flex rounded-full h-2 w-2',
                status.running ? 'bg-success' : status.error ? 'bg-destructive' : 'bg-foreground/40'
              )} />
              <span className="text-sm font-medium">
                {status.running
                  ? `@${status.botUsername}`
                  : status.error
                    ? 'Connection Error'
                    : 'Bot Stopped'
                }
              </span>
            </div>

            {status.error && (
              <div className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
                {status.error}
              </div>
            )}

            <div className="flex gap-2">
              {status.running ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleStop}
                  disabled={loading}
                  className="flex-1 text-xs"
                >
                  {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <PowerOff className="h-3 w-3 mr-1" />}
                  Stop
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleStart}
                    disabled={loading}
                    className="flex-1 text-xs"
                  >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Power className="h-3 w-3 mr-1" />}
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleReset}
                    disabled={loading}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    Reset
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.38-.49 1.04-.74 4.09-1.78 6.82-2.96 8.18-3.52 3.9-1.62 4.71-1.9 5.24-1.91.12 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"
        fill="currentColor"
      />
    </svg>
  )
}
