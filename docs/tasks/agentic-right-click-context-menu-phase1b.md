# Phase 1b: Rewind (Edit & Resend)

> First functional action in the context menu. Truncates conversation at a message, allows editing, and resends.
>
> **Status:** Complete
> **Release notes:** [`docs/releases/agentic-right-click-context-menu-phase1b.md`](../releases/agentic-right-click-context-menu-phase1b.md)

## Tasks

### 1. Add `rewind` SessionCommand and `session_rewound` SessionEvent types
- [x] Add `| { type: 'rewind'; messageId: string }` to `SessionCommand` union
- [x] Add `| { type: 'session_rewound'; sessionId: string; messages: Message[]; prefillText: string }` to `SessionEvent` union
- [x] File: `apps/electron/src/shared/types.ts`

### 2. Add event processor types
- [x] Add `SessionRewoundEvent` interface
- [x] Add `SessionRewoundEvent` to `AgentEvent` union
- [x] Add `prefill_input` effect type
- [x] File: `apps/electron/src/renderer/event-processor/types.ts`

### 3. Add `handleSessionRewound` event handler
- [x] Replace messages array with truncated version from event
- [x] Set `isProcessing: false`, clear `currentStatus` and `streaming`
- [x] Emit `prefill_input` effect with the original message text
- [x] File: `apps/electron/src/renderer/event-processor/handlers/session.ts`

### 4. Wire handler in processor switch
- [x] Add `case 'session_rewound'` before default exhaustive check
- [x] File: `apps/electron/src/renderer/event-processor/processor.ts`

### 5. Implement `rewindToMessage()` in SessionManager
- [x] Call `ensureMessagesLoaded()` for lazy-loaded sessions
- [x] Find target message by ID, validate it's a user message
- [x] Abort active agent if processing
- [x] Capture original text for pre-fill
- [x] Truncate messages to before the target message
- [x] Reset `streamingText`, `sdkSessionId`, `agent`
- [x] Persist and flush to disk
- [x] Emit `session_rewound` event
- [x] File: `apps/electron/src/main/sessions.ts`

### 6. Add IPC handler
- [x] Add `case 'rewind'` to SESSION_COMMAND switch
- [x] File: `apps/electron/src/main/ipc.ts`

### 7. Handle `prefill_input` effect in App.tsx
- [x] Set draft in `sessionDraftsRef` and persist via `setDraft`
- [x] Dispatch `craft:draft-changed` custom event for ChatPage sync
- [x] File: `apps/electron/src/renderer/App.tsx`

### 8. Add draft change listener in ChatPage
- [x] Listen for `craft:draft-changed` custom event
- [x] Update `inputValue` state and `inputValueRef` when session matches
- [x] File: `apps/electron/src/renderer/pages/ChatPage.tsx`

### 9. Build inline edit UI in ChatDisplay
- [x] Add `editingMessageId`, `editingText` state, `editTextareaRef`
- [x] Auto-focus and auto-resize textarea on edit start
- [x] Replace message bubble with inline textarea when editing
- [x] Send button (ArrowUp icon) + Cancel button
- [x] Enter sends, Escape cancels, Shift+Enter for newline
- [x] `handleEditSend`: rewind via IPC then `onSendMessage(editedText)`
- [x] Error handling: fallback to send if rewind fails
- [x] Disable context menu trigger while editing
- [x] File: `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`

### 10. Wire Copy menu item
- [x] `onSelect={() => navigator.clipboard.writeText(turn.message.content)}`
- [x] File: `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`

### 11. Build & typecheck
- [x] Run typecheck — no new errors from our changes
- [x] Manual test: Edit & Resend rewinds conversation and sends edited message
- [x] Manual test: Copy copies message text to clipboard

## Files modified

| File | Change |
|------|--------|
| `apps/electron/src/shared/types.ts` | `rewind` command + `session_rewound` event |
| `apps/electron/src/renderer/event-processor/types.ts` | `SessionRewoundEvent`, `prefill_input` effect |
| `apps/electron/src/renderer/event-processor/handlers/session.ts` | `handleSessionRewound` handler |
| `apps/electron/src/renderer/event-processor/processor.ts` | `session_rewound` case |
| `apps/electron/src/main/sessions.ts` | `rewindToMessage()` method |
| `apps/electron/src/main/ipc.ts` | `rewind` IPC case |
| `apps/electron/src/renderer/App.tsx` | `prefill_input` effect handler |
| `apps/electron/src/renderer/pages/ChatPage.tsx` | `craft:draft-changed` listener |
| `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` | Inline edit UI + Copy wiring |

## Acceptance criteria — all met

- Right-clicking a user message → "Edit & Resend" opens inline editor with original text
- Editing text and pressing Enter/Send rewinds the conversation and sends the new message
- Pressing Escape/Cancel closes the editor without changes
- Copy menu item copies the message text to clipboard
- No typecheck regressions
