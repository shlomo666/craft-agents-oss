# Phase 1a: User Message Context Menu

> Replace Electron's default right-click menu with a custom styled context menu on user messages.
>
> **Status:** Complete
> **Release notes:** [`docs/releases/agentic-right-click-context-menu-phase1a.md`](../releases/agentic-right-click-context-menu-phase1a.md)

## Tasks

### 1. Wrap user messages with Radix ContextMenu in ChatDisplay
- [x] Import `ContextMenu`, `ContextMenuTrigger`, `StyledContextMenuContent`, `StyledContextMenuItem`, `StyledContextMenuSeparator` from existing styled-context-menu components
- [x] In `ChatDisplay.tsx`, wrap the `user` turn rendering block (`<div className={CHAT_LAYOUT.userMessagePadding}>`) with `<ContextMenu>` + `<ContextMenuTrigger asChild>`
- [x] Add placeholder menu items (disabled) to verify the menu renders
- [x] File: `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`

### 2. Suppress default Electron context menu on user messages
- [x] Verified: Radix's `ContextMenu` prevents the default browser/Electron context menu automatically via `preventDefault` on the `contextmenu` event
- [x] Test: right-click a user message — custom menu appears, NO "Inspect Element / Cut / Copy / Paste"

### 3. Disable menu during processing / pending / queued states
- [x] Pass `disabled` prop to `ContextMenuTrigger` when `session.isProcessing`, `message.isPending`, or `message.isQueued` is true
- [x] Verified: right-click during active streaming shows no menu

### 4. Add all action items with icons
- [x] "Edit & Resend" — Pencil icon — disabled placeholder (Phase 1b)
- [x] "Retry" — RefreshCw icon — disabled placeholder (Phase 1b)
- [x] Separator
- [x] "Rephrase..." — Sparkles icon — disabled placeholder (Phase 2)
- [x] "Create Group..." — Users icon — disabled placeholder (Phase 3)
- [x] Separator
- [x] "Branch from Here" — GitBranch icon — disabled placeholder (Phase 1c)
- [x] Separator
- [x] "Copy" — Copy icon — disabled placeholder (next to wire)
- [x] Menu looks consistent with other context menus in the app (session list, etc.)

### 5. Handle edge cases
- [x] User messages with attachments — menu still works
- [x] User messages with content badges — menu still works
- [x] Very long messages — menu positions correctly (Radix handles this)
- [x] First message in conversation — menu works
- [x] Last message in conversation — menu works

### 6. Build & typecheck
- [x] Run `bun run typecheck` in `apps/electron/` — no new errors from our changes
- [x] Manual test: run the dev server, right-click user messages, verify custom menu appears

## Files modified

| File | Change |
|------|--------|
| `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` | Import context menu components + 6 lucide icons, wrap user message block with ContextMenu |

## Acceptance criteria — all met

- Right-clicking any user message shows our custom styled context menu
- The default Electron context menu ("Inspect Element / Cut / Copy / Paste") no longer appears on user messages
- All planned menu items are visible but disabled (placeholders for future phases)
- Menu does not appear during processing or on pending/queued messages
- No typecheck regressions
- Menu styling matches existing context menus in the app
