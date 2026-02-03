/**
 * Session Control MCP Server
 *
 * Provides MCP tools for managing Craft Agent sessions from within a session.
 * This enables the "Telegram Agent Orchestrator" pattern where one session
 * (the controller) can spawn, monitor, message, and stop other sessions.
 *
 * Architecture:
 *   Controller Session ──uses──> session-control MCP ──manages──> Worker Sessions
 *
 * Tools:
 * - list_sessions: List all sessions with status
 * - create_session: Create a new session
 * - send_message: Send a message to a session and optionally wait for response
 * - get_session_status: Get detailed status of a session
 * - get_session_messages: Retrieve recent messages from a session
 * - stop_session: Cancel processing in a session
 * - delete_session: Delete a session entirely
 * - rename_session: Rename a session
 * - set_session_labels: Add/remove labels from a session
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionManager } from './sessions';
import type { SessionEvent } from '../shared/types';
import { sessionLog } from './logger';

const debug = (...args: unknown[]) => sessionLog.debug('[SessionControlMCP]', ...args);

/**
 * Create the session control MCP server.
 * Must be called from the Electron main process where SessionManager is available.
 *
 * @param sessionManager - The SessionManager instance from main process
 * @param controllerSessionId - The session ID of the controller (to prevent self-management loops)
 */
export function createSessionControlMcpServer(
  sessionManager: SessionManager,
  controllerSessionId: string
) {
  return createSdkMcpServer({
    name: 'session-control',
    version: '1.0.0',
    tools: [
      // ============================================================
      // list_sessions - List all sessions with status
      // ============================================================
      tool(
        'list_sessions',
        `List all active sessions in the current workspace.

Returns a list of sessions with their ID, name, status (processing/idle), labels,
message count, and token usage. Use this to see what sessions exist and their current state.

**Note:** This lists sessions from the in-memory session manager. Sessions that haven't
been loaded into memory won't appear until they're accessed.`,
        {
          includeMessages: z.boolean().optional().describe('Include last 3 messages from each session (default: false)'),
        },
        async (args) => {
          debug('list_sessions called');
          try {
            const sessions = sessionManager.getSessions();

            const result = sessions.map(session => ({
              id: session.id,
              name: session.name || undefined,
              workspaceId: session.workspaceId,
              isProcessing: session.isProcessing,
              isFlagged: session.isFlagged,
              labels: session.labels || [],
              permissionMode: session.permissionMode,
              messageCount: session.messageCount,
              lastMessageAt: session.lastMessageAt,
              hasUnread: session.hasUnread,
              tokenUsage: session.tokenUsage,
              isController: session.id === controllerSessionId,
              // Optionally include recent messages
              recentMessages: args.includeMessages
                ? session.messages?.slice(-3).map(m => ({
                    role: m.role,
                    content: m.content?.slice(0, 200) + (m.content && m.content.length > 200 ? '...' : ''),
                  }))
                : undefined,
            }));

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              }],
            };
          } catch (error) {
            debug('list_sessions error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error listing sessions: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // create_session - Create a new session
      // ============================================================
      tool(
        'create_session',
        `Create a new agent session.

Creates a new session that can run independently. You can optionally set:
- Working directory for the session
- Permission mode (safe, ask, allow-all)
- Initial message to send immediately after creation

Returns the new session's ID and details.`,
        {
          workspaceId: z.string().optional().describe('Workspace ID (defaults to current workspace)'),
          workingDirectory: z.string().optional().describe('Working directory for the session'),
          permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional().describe('Permission mode (default: allow-all for programmatic sessions)'),
          initialMessage: z.string().optional().describe('Initial message to send to the session'),
          labels: z.array(z.string()).optional().describe('Labels to apply to the session'),
        },
        async (args) => {
          debug('create_session called with:', args);
          try {
            // Get current workspace if not specified
            const { getActiveWorkspace } = await import('@craft-agent/shared/config');
            const workspace = getActiveWorkspace();
            const workspaceId = args.workspaceId || workspace?.id;

            if (!workspaceId) {
              return {
                content: [{
                  type: 'text' as const,
                  text: 'Error: No workspace ID provided and no active workspace found',
                }],
                isError: true,
              };
            }

            const session = await sessionManager.createSession(workspaceId, {
              workingDirectory: args.workingDirectory,
              permissionMode: args.permissionMode || 'allow-all',
            });

            // Apply labels if specified
            if (args.labels && args.labels.length > 0) {
              sessionManager.setSessionLabels(session.id, args.labels);
            }

            // Send initial message if provided
            if (args.initialMessage) {
              await sessionManager.sendMessage(session.id, args.initialMessage);
            }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  sessionId: session.id,
                  workspaceId: session.workspaceId,
                  permissionMode: session.permissionMode,
                  workingDirectory: session.workingDirectory,
                  message: args.initialMessage
                    ? 'Session created and initial message sent'
                    : 'Session created successfully',
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('create_session error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error creating session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // send_message - Send a message to a session
      // ============================================================
      tool(
        'send_message',
        `Send a message to an existing session.

Sends a message to the specified session and optionally waits for the response.
Use this to communicate with worker sessions.

**Options:**
- waitForResponse: If true, waits for the agent to finish responding and returns the response
- timeoutMs: Maximum time to wait for response (default: 120000ms = 2 minutes)

**Note:** If the session is already processing, the message will be queued.`,
        {
          sessionId: z.string().describe('The ID of the session to message'),
          message: z.string().describe('The message to send'),
          waitForResponse: z.boolean().optional().describe('Wait for and return the response (default: false)'),
          timeoutMs: z.number().optional().describe('Timeout in milliseconds when waiting (default: 120000)'),
        },
        async (args) => {
          debug('send_message called:', args.sessionId, 'waitForResponse:', args.waitForResponse);

          // Prevent sending to self (infinite loop)
          if (args.sessionId === controllerSessionId) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Error: Cannot send message to the controller session (this would cause an infinite loop)',
              }],
              isError: true,
            };
          }

          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            if (args.waitForResponse) {
              // Wait for response by subscribing to session events
              const timeoutMs = args.timeoutMs || 120000;

              return new Promise((resolve) => {
                let responseText = '';
                let completed = false;

                const timeout = setTimeout(() => {
                  if (!completed) {
                    completed = true;
                    unsubscribe();
                    resolve({
                      content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                          success: false,
                          error: 'Timeout waiting for response',
                          partialResponse: responseText || undefined,
                        }, null, 2),
                      }],
                      isError: true,
                    });
                  }
                }, timeoutMs);

                const unsubscribe = sessionManager.onSessionEvent(args.sessionId, (event: SessionEvent) => {
                  if (completed) return;

                  if (event.type === 'text_delta') {
                    responseText += event.delta;
                  } else if (event.type === 'text_complete' && !event.isIntermediate) {
                    responseText = event.text;
                  } else if (event.type === 'complete') {
                    completed = true;
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve({
                      content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                          success: true,
                          sessionId: args.sessionId,
                          response: responseText,
                        }, null, 2),
                      }],
                    });
                  } else if (event.type === 'error' || event.type === 'typed_error') {
                    completed = true;
                    clearTimeout(timeout);
                    unsubscribe();
                    const errorMsg = event.type === 'error' ? event.error : event.error?.message;
                    resolve({
                      content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                          success: false,
                          error: errorMsg,
                          partialResponse: responseText || undefined,
                        }, null, 2),
                      }],
                      isError: true,
                    });
                  }
                });

                // Send the message after setting up the listener
                sessionManager.sendMessage(args.sessionId, args.message).catch(err => {
                  if (!completed) {
                    completed = true;
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve({
                      content: [{
                        type: 'text' as const,
                        text: `Error sending message: ${err.message}`,
                      }],
                      isError: true,
                    });
                  }
                });
              });
            } else {
              // Fire and forget
              await sessionManager.sendMessage(args.sessionId, args.message);

              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: true,
                    sessionId: args.sessionId,
                    message: 'Message sent (not waiting for response)',
                  }, null, 2),
                }],
              };
            }
          } catch (error) {
            debug('send_message error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error sending message: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // get_session_status - Get detailed status of a session
      // ============================================================
      tool(
        'get_session_status',
        `Get detailed status information about a session.

Returns:
- Processing state (is the agent currently running?)
- Token usage (input, output, cache, cost)
- Message count
- Labels and flags
- Permission mode
- Working directory`,
        {
          sessionId: z.string().describe('The ID of the session to check'),
        },
        async (args) => {
          debug('get_session_status called:', args.sessionId);
          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  id: session.id,
                  name: session.name,
                  workspaceId: session.workspaceId,
                  isProcessing: session.isProcessing,
                  isFlagged: session.isFlagged,
                  labels: session.labels || [],
                  permissionMode: session.permissionMode,
                  workingDirectory: session.workingDirectory,
                  messageCount: session.messageCount,
                  lastMessageAt: session.lastMessageAt,
                  hasUnread: session.hasUnread,
                  tokenUsage: session.tokenUsage,
                  todoState: session.todoState,
                  isController: session.id === controllerSessionId,
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('get_session_status error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error getting session status: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // get_session_messages - Retrieve messages from a session
      // ============================================================
      tool(
        'get_session_messages',
        `Retrieve messages from a session's conversation history.

Returns the specified range of messages with their content, role, and timestamps.
Use limit and offset for pagination.

**Tip:** Start with the most recent messages (no offset) to see current state.`,
        {
          sessionId: z.string().describe('The ID of the session'),
          limit: z.number().optional().describe('Maximum number of messages to return (default: 20)'),
          offset: z.number().optional().describe('Number of messages to skip from the end (default: 0)'),
          includeTools: z.boolean().optional().describe('Include tool use/result messages (default: false)'),
        },
        async (args) => {
          debug('get_session_messages called:', args.sessionId);
          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            // Load messages if not already loaded
            const messages = session.messages || [];
            const limit = args.limit || 20;
            const offset = args.offset || 0;

            // Filter to user/assistant messages unless includeTools is true
            const filtered = args.includeTools
              ? messages
              : messages.filter(m => m.role === 'user' || m.role === 'assistant');

            // Get the specified range from the end
            const startIdx = Math.max(0, filtered.length - limit - offset);
            const endIdx = filtered.length - offset;
            const subset = filtered.slice(startIdx, endIdx);

            const result = subset.map(m => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              toolName: m.toolName || undefined,
              isIntermediate: m.isIntermediate || undefined,
            }));

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  sessionId: args.sessionId,
                  totalMessages: messages.length,
                  filteredCount: filtered.length,
                  returned: result.length,
                  offset: offset,
                  messages: result,
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('get_session_messages error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error getting messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // stop_session - Cancel processing in a session
      // ============================================================
      tool(
        'stop_session',
        `Stop/cancel the currently running operation in a session.

If the session is processing a message, this will interrupt the agent.
The session will remain open and can receive new messages.`,
        {
          sessionId: z.string().describe('The ID of the session to stop'),
        },
        async (args) => {
          debug('stop_session called:', args.sessionId);

          // Prevent stopping self
          if (args.sessionId === controllerSessionId) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Error: Cannot stop the controller session from itself',
              }],
              isError: true,
            };
          }

          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            if (!session.isProcessing) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: true,
                    sessionId: args.sessionId,
                    message: 'Session was not processing (already idle)',
                  }, null, 2),
                }],
              };
            }

            await sessionManager.cancelProcessing(args.sessionId);

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  sessionId: args.sessionId,
                  message: 'Session processing stopped',
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('stop_session error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error stopping session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // delete_session - Delete a session entirely
      // ============================================================
      tool(
        'delete_session',
        `Delete a session and all its data.

**WARNING:** This permanently deletes the session and all its messages.
Use with caution - this cannot be undone.`,
        {
          sessionId: z.string().describe('The ID of the session to delete'),
          force: z.boolean().optional().describe('Delete even if session is processing (default: false)'),
        },
        async (args) => {
          debug('delete_session called:', args.sessionId);

          // Prevent deleting self
          if (args.sessionId === controllerSessionId) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Error: Cannot delete the controller session from itself',
              }],
              isError: true,
            };
          }

          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            if (session.isProcessing && !args.force) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session is currently processing. Use force=true to delete anyway, or stop the session first.`,
                }],
                isError: true,
              };
            }

            await sessionManager.deleteSession(args.sessionId);

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  sessionId: args.sessionId,
                  message: 'Session deleted',
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('delete_session error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error deleting session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // rename_session - Rename a session
      // ============================================================
      tool(
        'rename_session',
        `Rename a session.

Sets a custom name for the session that appears in the session list.`,
        {
          sessionId: z.string().describe('The ID of the session to rename'),
          name: z.string().describe('The new name for the session'),
        },
        async (args) => {
          debug('rename_session called:', args.sessionId, args.name);
          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            await sessionManager.renameSession(args.sessionId, args.name);

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  sessionId: args.sessionId,
                  name: args.name,
                  message: 'Session renamed',
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('rename_session error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error renaming session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),

      // ============================================================
      // set_session_labels - Set labels on a session
      // ============================================================
      tool(
        'set_session_labels',
        `Set labels on a session.

Labels are tags that can be used to organize and filter sessions.
This replaces all existing labels with the new set.`,
        {
          sessionId: z.string().describe('The ID of the session'),
          labels: z.array(z.string()).describe('The labels to set (replaces existing labels)'),
        },
        async (args) => {
          debug('set_session_labels called:', args.sessionId, args.labels);
          try {
            const session = await sessionManager.getSession(args.sessionId);
            if (!session) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error: Session '${args.sessionId}' not found`,
                }],
                isError: true,
              };
            }

            sessionManager.setSessionLabels(args.sessionId, args.labels);

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  sessionId: args.sessionId,
                  labels: args.labels,
                  message: 'Labels updated',
                }, null, 2),
              }],
            };
          } catch (error) {
            debug('set_session_labels error:', error);
            return {
              content: [{
                type: 'text' as const,
                text: `Error setting labels: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}

/**
 * Type for the session control MCP server
 */
export type SessionControlMcpServer = ReturnType<typeof createSessionControlMcpServer>;
