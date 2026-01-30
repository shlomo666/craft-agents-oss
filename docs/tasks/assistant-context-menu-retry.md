# Task: Assistant Message Context Menu — Retry + Copy

> Part of [CORE FEATURE: User Message Dialogue](../CORE-FEATURE-agentic-right-click-context-menu.md)

## Context

The user message context menu (Phase 1a+1b) is complete with Edit & Resend, Copy, and placeholder items. **Retry** belongs on the **assistant message** context menu — when you right-click an agent's response, you should be able to retry that response (rewind to the preceding user message and resend it unchanged).

Currently, right-clicking an assistant message shows Electron's default "Inspect Element" menu.

## Scope

- Wrap assistant turn rendering (`<TurnCard>`) with `<ContextMenu>` + `<ContextMenuTrigger>`
- Add **Retry** menu item: finds the preceding user message, rewinds the conversation to it, and resends the same text
- Add **Copy** menu item: copies the assistant's response text to clipboard
- Menu disabled while session is processing or turn is still streaming

## Technical Details

### Retry Flow
1. Find the preceding user turn in the `turns` array (search backward from current index)
2. Call `sessionCommand(sessionId, { type: 'rewind', messageId: precedingUserTurn.message.id })`
3. On success, call `onSendMessage(precedingUserTurn.message.content)` to resend the same text
4. Reuses the entire rewind pipeline from Phase 1b — no backend changes needed

### Copy Flow
- `turn.response?.text` contains the assistant's response text
- `navigator.clipboard.writeText(turn.response.text)`

### Files Modified
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` — wrap `<TurnCard>` with context menu

### No Backend Changes
Retry reuses the existing `rewind` SessionCommand + `rewindToMessage()` in SessionManager. The entire pipeline (types → IPC → sessions → event processor → effects) is already in place from Phase 1b.

## Checklist

- [x] Document task scope and technical approach
- [x] Wrap `<TurnCard>` with `<ContextMenu>`
- [x] Add Retry menu item (rewind + resend preceding user message)
- [x] Add Copy menu item (copy response text)
- [x] Menu disabled during processing/streaming
- [x] Typecheck passes (0 new errors)
- [x] Manual testing — Retry rewinds and resends, Copy copies text

## Completed

Committed as `af29745` — `feat: assistant message context menu with Retry & Copy`
