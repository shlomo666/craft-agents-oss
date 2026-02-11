/**
 * Matrix IPC handlers — registers ipcMain handlers for Matrix bot management
 *
 * Follows the Telegram pattern: separate file, called from registerIpcHandlers().
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import type { MatrixService } from './matrix'
import type { WindowManager } from './window-manager'
import log from './logger'

const matrixIpcLog = log.scope('matrix-ipc')

const MATRIX_CREDENTIAL_ID = {
  type: 'source_bearer' as const,
  sourceId: 'matrix-bot',
}

const MATRIX_HOMESERVER_KEY = 'matrix-homeserver'

export function registerMatrixHandlers(
  matrixService: MatrixService,
  windowManager: WindowManager,
): void {
  ipcMain.handle(IPC_CHANNELS.MATRIX_GET_STATUS, async () => {
    return matrixService.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.MATRIX_CONNECT, async (_event, homeserver: string, accessToken: string) => {
    const credManager = getCredentialManager()

    // If token is empty, try to use stored credentials (reconnect flow)
    let finalHomeserver = homeserver
    let finalToken = accessToken
    if (!accessToken) {
      const storedToken = await credManager.get(MATRIX_CREDENTIAL_ID)
      const storedHomeserver = await credManager.get({ type: 'source_bearer', sourceId: MATRIX_HOMESERVER_KEY })
      if (storedToken?.value && storedHomeserver?.value) {
        finalToken = storedToken.value
        finalHomeserver = storedHomeserver.value
        matrixIpcLog.info('Using stored Matrix credentials for reconnect')
      } else {
        matrixIpcLog.warn('No stored credentials found for reconnect')
        return matrixService.getStatus()
      }
    } else {
      // Store new credentials in encrypted storage
      await credManager.set(MATRIX_CREDENTIAL_ID, { value: accessToken })
      await credManager.set({ type: 'source_bearer', sourceId: MATRIX_HOMESERVER_KEY }, { value: homeserver })
      matrixIpcLog.info('Matrix credentials saved')
    }

    // Connect with the credentials
    const status = await matrixService.connect(finalHomeserver, finalToken)

    // Broadcast status to all windows
    broadcastMatrixStatus(windowManager, status)

    return status
  })

  ipcMain.handle(IPC_CHANNELS.MATRIX_DISCONNECT, async () => {
    await matrixService.disconnect()

    // Clear stored credentials so user can re-enter them
    const credManager = getCredentialManager()
    await credManager.delete(MATRIX_CREDENTIAL_ID)
    await credManager.delete({ type: 'source_bearer', sourceId: MATRIX_HOMESERVER_KEY })
    matrixService.clearCredentialStatus()
    matrixIpcLog.info('Matrix credentials cleared')

    const status = matrixService.getStatus()
    broadcastMatrixStatus(windowManager, status)
    return status
  })

  ipcMain.handle(IPC_CHANNELS.MATRIX_CHECK_LOCAL, async () => {
    return matrixService.checkLocalServer()
  })
}

function broadcastMatrixStatus(windowManager: WindowManager, status: import('../shared/types').MatrixStatusInfo): void {
  try {
    const managed = windowManager.getAllWindows()
    for (const { window } of managed) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
        window.webContents.send(IPC_CHANNELS.MATRIX_STATUS_CHANGED, status)
      }
    }
  } catch {
    // Silently ignore broadcast failures
  }
}

/**
 * Auto-start Matrix client if credentials are stored.
 * Called during app initialization after SessionManager is ready.
 */
export async function autoStartMatrix(
  matrixService: MatrixService,
  windowManager: WindowManager,
): Promise<void> {
  try {
    const credManager = getCredentialManager()
    const tokenCred = await credManager.get(MATRIX_CREDENTIAL_ID)
    const homeserverCred = await credManager.get({ type: 'source_bearer', sourceId: MATRIX_HOMESERVER_KEY })

    if (tokenCred?.value && homeserverCred?.value) {
      matrixIpcLog.info('Found stored Matrix credentials, auto-connecting...')
      const status = await matrixService.connect(homeserverCred.value, tokenCred.value)
      if (status.connected) {
        matrixIpcLog.info(`Matrix auto-connected as ${status.userId}`)
      } else {
        matrixIpcLog.warn('Matrix auto-connect failed:', status.error)
      }
      broadcastMatrixStatus(windowManager, status)
    }
  } catch (err) {
    matrixIpcLog.error('Matrix auto-start error:', err)
  }
}
