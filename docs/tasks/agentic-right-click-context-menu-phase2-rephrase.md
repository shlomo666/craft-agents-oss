# Phase 2: Rephrase — AI-powered message rewrite

**Status:** Complete  
**Commit:** (pending)

## Overview

Add "Rephrase..." to the user message context menu. Clicking it calls Sonnet (via the Claude Agent SDK `query()` function) to rewrite the message with better clarity and context, then opens the existing Edit & Resend box pre-filled with the rephrased text. The user reviews, optionally tweaks, and sends — reusing the full rewind + resend pipeline from Phase 1b.

## Architecture

Follows the **Regenerate Title UX pattern** (copycat):
- Synchronous IPC return value (no new events/effects needed)
- `async_operation` events for shimmer animation during AI call
- `animate-shimmer-text` CSS class on the message bubble while rephrasing
- `sonner` toast for success/error feedback
- Edit & Resend box opens pre-filled with rephrased text

## Files Modified

### `apps/electron/src/shared/types.ts`
- [x] Added `{ type: 'rephrase'; messageId: string }` to `SessionCommand` union
- [x] Added `RephraseResult` interface (`{ success, rephrasedText?, error? }`)
- [x] Updated `sessionCommand` return type to include `RephraseResult`

### `packages/shared/src/utils/rephrase-generator.ts` (NEW)
- [x] `rephraseUserMessage(targetMessage, conversationContext)` — AI call
- [x] Uses `query()` from SDK with `DEFAULT_MODEL` (Sonnet)
- [x] Builds prompt with conversation context (last 10 messages, 500 chars each)
- [x] Prompt asks for clearer, more specific rewrite preserving intent
- [x] Returns `string | null`

### `packages/shared/src/utils/index.ts`
- [x] Added `export * from './rephrase-generator.ts'`

### `apps/electron/src/main/sessions.ts`
- [x] Added `rephraseMessage(sessionId, messageId)` method
- [x] Finds target user message + builds conversation context from preceding messages
- [x] Emits `async_operation { isOngoing: true }` for shimmer
- [x] Calls `rephraseUserMessage()`
- [x] Returns `{ success, rephrasedText }` (same pattern as `refreshTitle`)
- [x] Emits `async_operation { isOngoing: false }` in finally block

### `apps/electron/src/main/ipc.ts`
- [x] Added `case 'rephrase'` → `sessionManager.rephraseMessage()`

### `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`
- [x] Added `toast` import from `sonner`
- [x] Added `RephraseResult` type import
- [x] Added `rephrasingMessageId` state for per-message loading tracking
- [x] Replaced disabled "Rephrase..." menu item with working handler:
  - On click: set loading state → call IPC → on success open edit box with rephrased text + toast → on failure show error toast
  - Button text changes to "Rephrasing..." while loading
  - Menu item disabled while rephrasing that message
- [x] Added `animate-shimmer-text` class to message bubble during rephrasing

## Design Decisions

- **Model: Sonnet** (not Haiku) — rephrasing needs quality language understanding
- **No new events/effects** — follows Regenerate Title's synchronous IPC return pattern
- **Reuses Edit & Resend UI** — the edit box, rewind, and resend are already built
- **v1: single rephrase** — no multiple suggestions yet (future v2)
- **Shimmer animation** — same `animate-shimmer-text` CSS, applied per-message via local state
- **Conversation context** — last 10 messages, 500 chars each, for prompt grounding

## Verification

- [ ] TypeScript compilation: 0 new errors
- [ ] Manual test: right-click user message → Rephrase... → shimmer shows → edit box opens with rephrased text
- [ ] Manual test: send rephrased text works (rewind + resend pipeline)
- [ ] Manual test: cancel edit returns to original message
- [ ] Manual test: error case shows toast
- [ ] Context menu shows "Rephrasing..." while AI is working
