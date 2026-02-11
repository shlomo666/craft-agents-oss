/**
 * MatrixButton — Sidebar button for Matrix connection setup and status
 *
 * Three states:
 * 1. No credentials: Click opens popover with homeserver/token input
 * 2. Connected: Green dot, popover shows status + disconnect option
 * 3. Disconnected/Error: Yellow/red dot, popover shows connect option
 *
 * Auto-detects local Matrix server at localhost:8443.
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, Power, PowerOff, Loader2, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { MatrixStatusInfo } from '../../../shared/types'

export function MatrixButton() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<MatrixStatusInfo>({
    connected: false,
    userId: null,
    homeserver: null,
    hasCredentials: false,
    localDetected: false,
    error: null,
  })
  const [homeserverInput, setHomeserverInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checkingLocal, setCheckingLocal] = useState(false)
  const [localAvailable, setLocalAvailable] = useState<boolean | null>(null)

  // Fetch initial status
  useEffect(() => {
    window.electronAPI.matrixGetStatus().then(setStatus)
  }, [])

  // Listen for status changes
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMatrixStatusChanged(setStatus)
    return unsubscribe
  }, [])

  // Check for local server when popover opens
  useEffect(() => {
    if (open && !status.hasCredentials) {
      setCheckingLocal(true)
      window.electronAPI.matrixCheckLocal().then(result => {
        setLocalAvailable(result.available)
        if (result.available) {
          setHomeserverInput('http://localhost:8443')
        }
        setCheckingLocal(false)
      })
    }
  }, [open, status.hasCredentials])

  const handleConnect = useCallback(async () => {
    if (!homeserverInput.trim() || !tokenInput.trim()) return
    setLoading(true)
    try {
      const newStatus = await window.electronAPI.matrixConnect(
        homeserverInput.trim(),
        tokenInput.trim()
      )
      setStatus(newStatus)
      setTokenInput('')
      if (newStatus.connected) {
        setOpen(false)
      }
    } finally {
      setLoading(false)
    }
  }, [homeserverInput, tokenInput])

  const handleDisconnect = useCallback(async () => {
    setLoading(true)
    try {
      await window.electronAPI.matrixDisconnect()
      const newStatus = await window.electronAPI.matrixGetStatus()
      setStatus(newStatus)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleReconnect = useCallback(async () => {
    setLoading(true)
    try {
      // Re-use stored credentials
      const newStatus = await window.electronAPI.matrixConnect(
        status.homeserver || '',
        '' // Empty token means use stored
      )
      setStatus(newStatus)
    } finally {
      setLoading(false)
    }
  }, [status.homeserver])

  const statusDotColor = status.connected
    ? 'bg-success'
    : status.hasCredentials
      ? status.error ? 'bg-destructive' : 'bg-foreground/40'
      : 'bg-transparent'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 py-[7px] px-2 text-[13px] font-normal rounded-[6px]"
        >
          <MatrixIcon className="h-3.5 w-3.5 shrink-0" />
          Matrix
          {status.hasCredentials && (
            <span className="ml-auto relative inline-flex shrink-0">
              {status.connected && (
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
        className="w-80 p-3"
      >
        {!status.hasCredentials ? (
          // No credentials — show input form
          <div className="space-y-3">
            <div className="text-xs font-medium text-foreground/70">Connect to Matrix</div>

            {/* Local server detection */}
            {checkingLocal ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking for local server...
              </div>
            ) : localAvailable ? (
              <div className="flex items-center gap-2 text-xs text-success bg-success/10 rounded-md px-2 py-1.5">
                <Check className="h-3 w-3" />
                Local Matrix server detected at localhost:8443
              </div>
            ) : localAvailable === false ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-md px-2 py-1.5">
                <X className="h-3 w-3" />
                No local server found
              </div>
            ) : null}

            {/* Homeserver input */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Homeserver URL</label>
              <Input
                type="text"
                value={homeserverInput}
                onChange={(e) => setHomeserverInput(e.target.value)}
                placeholder="https://matrix.example.com"
                className="text-xs h-8"
              />
            </div>

            {/* Access token input */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Access Token</label>
              <div className="relative rounded-md bg-muted/50 has-[:focus-visible]:bg-background">
                <Input
                  type={showToken ? 'text' : 'password'}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="syt_..."
                  className="pr-10 bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:outline-none text-xs h-8"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConnect()
                  }}
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
            </div>

            <Button
              size="sm"
              onClick={handleConnect}
              disabled={!homeserverInput.trim() || !tokenInput.trim() || loading}
              className="w-full text-xs"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Connect
            </Button>

            <p className="text-[10px] text-muted-foreground">
              Get an access token from Element: Settings → Help & About → Access Token
            </p>
          </div>
        ) : (
          // Credentials exist — show status
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={cn(
                'relative inline-flex rounded-full h-2 w-2',
                status.connected ? 'bg-success' : status.error ? 'bg-destructive' : 'bg-foreground/40'
              )} />
              <span className="text-sm font-medium">
                {status.connected
                  ? status.userId
                  : status.error
                    ? 'Connection Error'
                    : 'Disconnected'
                }
              </span>
            </div>

            {status.homeserver && (
              <div className="text-xs text-muted-foreground truncate">
                {status.homeserver}
              </div>
            )}

            {status.error && (
              <div className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
                {status.error}
              </div>
            )}

            <div className="flex gap-2">
              {status.connected ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={loading}
                  className="flex-1 text-xs"
                >
                  {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <PowerOff className="h-3 w-3 mr-1" />}
                  Disconnect
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleReconnect}
                    disabled={loading}
                    className="flex-1 text-xs"
                  >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Power className="h-3 w-3 mr-1" />}
                    Reconnect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleDisconnect}
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

function MatrixIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        d="M1 2.5V21.5H2.5V23H4V21.5H20V23H21.5V21.5H23V2.5H21.5V1H20V2.5H4V1H2.5V2.5H1ZM4 4.5H20V19.5H4V4.5ZM6 7V17H8V13H10V17H12V7H10V11H8V7H6ZM14 7V17H16V13H18V17H20V7H18V11H16V7H14Z"
        fill="currentColor"
      />
    </svg>
  )
}
