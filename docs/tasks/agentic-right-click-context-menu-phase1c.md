# Task: Phase 1c — Branch from Here

> Part of [CORE FEATURE: User Message Dialogue](../CORE-FEATURE-agentic-right-click-context-menu.md)

## Context

Phase 1b introduced `rewind` — truncate a session at a message and resend. "Branch from Here" does something similar but non-destructive: it creates a **new session** with messages copied up to (but excluding) the target user message, then navigates to that new session with the message text pre-filled in the input.

The original conversation is untouched. The user gets a fresh fork to take a different direction.

## Scope

8 files across 4 layers, following the exact same pipeline as `rewind`:

### Layer 1: Shared Types (`apps/electron/src/shared/types.ts`)
- Add `{ type: 'branch'; messageId: string }` to `SessionCommand` union
- Add `{ type: 'session_branched'; sessionId: string; newSession: Session; prefillText: string }` to `SessionEvent` union

### Layer 2: Backend (`apps/electron/src/main/`)
- **SessionManager** (`sessions.ts`): Add `branchFromMessage(sessionId, messageId)` method
  1. Validate session exists and message is a user message
  2. Ensure messages are loaded (`ensureMessagesLoaded`)
  3. Create a new session via `createSession(workspaceId)`
  4. Copy messages up to (excluding) the target message into the new session
  5. Copy session settings (permissionMode, thinkingLevel, workingDirectory, enabledSourceSlugs)
  6. Capture target message text for pre-fill
  7. Persist the new session
  8. Emit `session_branched` event with the new `Session` object + prefillText
- **IPC** (`ipc.ts`): Add `case 'branch'` → `sessionManager.branchFromMessage(sessionId, command.messageId)`

### Layer 3: Event Processor (`apps/electron/src/renderer/event-processor/`)
- **Types** (`types.ts`):
  - Add `SessionBranchedEvent` interface
  - Add to `AgentEvent` union
  - Add `branch_created` effect: `{ type: 'branch_created'; newSession: Session; prefillText: string }`
- **Handler** (`handlers/session.ts`): Add `handleSessionBranched()` — returns `branch_created` effect (no state mutation on current session)
- **Processor** (`processor.ts`): Add `case 'session_branched'` → `handleSessionBranched(state, event)`

### Layer 4: Renderer (`apps/electron/src/renderer/`)
- **App.tsx**: Handle `branch_created` effect:
  1. Add the new session to store via `addSession(effect.newSession)`
  2. Set draft text on the new session
  3. Navigate to the new session via `setActiveSessionId(effect.newSession.id)`
- **ChatDisplay.tsx**: Enable the "Branch from Here" menu item — `onSelect` calls `sessionCommand(sessionId, { type: 'branch', messageId })`

## Technical Details

### branchFromMessage vs rewindToMessage

| Aspect | rewind | branch |
|--------|--------|--------|
| Original session | Truncated | Untouched |
| New session | No | Yes (copy of messages) |
| Pre-fill | Yes (in same session) | Yes (in new session) |
| Agent reset | Yes (same session) | N/A (new session starts fresh) |
| Navigation | Stay | Navigate to new session |

### Session Settings to Copy

The branched session should inherit these from the source:
- `permissionMode`
- `thinkingLevel`
- `workingDirectory`
- `enabledSourceSlugs`

### Edge Cases
- If session is currently processing: still allow branch (non-destructive, just copies messages)
- Empty conversation (no messages before target): creates new session with empty history + prefill
- Target message is the first message: same as starting a new conversation with that text

## Verification

- [ ] TypeScript compiles with 0 new errors
- [ ] Branch from first message → new session with empty history + prefill
- [ ] Branch from middle message → new session with messages up to that point + prefill
- [ ] Original session is completely untouched after branch
- [ ] New session appears in sidebar with correct name
- [ ] Draft text is pre-filled in the new session's input
- [ ] Menu item is disabled during processing/pending/queued states
- [ ] Settings (permission mode, thinking level, working dir) are inherited

## Checklist

- [ ] Add `branch` to `SessionCommand` type
- [ ] Add `session_branched` to `SessionEvent` type
- [ ] Add `SessionBranchedEvent` + `branch_created` effect to event processor types
- [ ] Implement `branchFromMessage()` in SessionManager
- [ ] Add `branch` case to IPC handler
- [ ] Add `handleSessionBranched()` handler
- [ ] Add `session_branched` case to processor
- [ ] Handle `branch_created` effect in App.tsx
- [ ] Enable "Branch from Here" menu item in ChatDisplay.tsx
- [ ] TypeScript compiles cleanly
- [ ] Manual testing passes all verification items
