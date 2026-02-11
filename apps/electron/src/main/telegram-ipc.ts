/**
 * Telegram IPC handlers — registers ipcMain handlers for Telegram bot management
 *
 * Follows the onboarding pattern: separate file, called from registerIpcHandlers().
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import type { TelegramService } from './telegram'
import type { WindowManager } from './window-manager'
import log from './logger'

const telegramIpcLog = log.scope('telegram-ipc')

const TELEGRAM_CREDENTIAL_ID = {
  type: 'source_bearer' as const,
  sourceId: 'telegram-bot',
}

export function registerTelegramHandlers(
  telegramService: TelegramService,
  windowManager: WindowManager,
): void {
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_GET_STATUS, async () => {
    return telegramService.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_SET_TOKEN, async (_event, token: string) => {
    const credManager = getCredentialManager()

    // Store token in encrypted credential storage
    await credManager.set(TELEGRAM_CREDENTIAL_ID, { value: token })
    telegramIpcLog.info('Telegram bot token saved')

    // Start the bot with the new token
    const status = await telegramService.start(token)

    // Broadcast status to all windows
    broadcastTelegramStatus(windowManager, status)

    return status
  })

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_START, async () => {
    const credManager = getCredentialManager()
    const cred = await credManager.get(TELEGRAM_CREDENTIAL_ID)
    if (!cred?.value) {
      return { running: false, botUsername: null, hasToken: false, error: 'No token configured' }
    }

    const status = await telegramService.start(cred.value)
    broadcastTelegramStatus(windowManager, status)
    return status
  })

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_STOP, async () => {
    await telegramService.stop()
    const status = telegramService.getStatus()
    broadcastTelegramStatus(windowManager, status)
    return status
  })

  // Clear token and stop - for "Reset" functionality
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_CLEAR_TOKEN, async () => {
    await telegramService.stop()
    const credManager = getCredentialManager()
    await credManager.delete(TELEGRAM_CREDENTIAL_ID)
    telegramService.clearTokenStatus()
    telegramIpcLog.info('Telegram bot token cleared')
    const status = telegramService.getStatus()
    broadcastTelegramStatus(windowManager, status)
    return status
  })
}

function broadcastTelegramStatus(windowManager: WindowManager, status: import('../shared/types').TelegramStatusInfo): void {
  try {
    const managed = windowManager.getAllWindows()
    for (const { window } of managed) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
        window.webContents.send(IPC_CHANNELS.TELEGRAM_STATUS_CHANGED, status)
      }
    }
  } catch {
    // Silently ignore broadcast failures
  }
}

/**
 * Auto-start Telegram bot if a token is stored.
 * Called during app initialization after SessionManager is ready.
 */
export async function autoStartTelegram(
  telegramService: TelegramService,
  windowManager: WindowManager,
): Promise<void> {
  try {
    const credManager = getCredentialManager()
    const cred = await credManager.get(TELEGRAM_CREDENTIAL_ID)
    if (cred?.value) {
      telegramIpcLog.info('Found stored Telegram token, auto-starting bot...')
      const status = await telegramService.start(cred.value)
      if (status.running) {
        telegramIpcLog.info(`Telegram bot auto-started as @${status.botUsername}`)
      } else {
        telegramIpcLog.warn('Telegram bot auto-start failed:', status.error)
      }
      broadcastTelegramStatus(windowManager, status)
    }
  } catch (err) {
    telegramIpcLog.error('Telegram auto-start error:', err)
  }
}
