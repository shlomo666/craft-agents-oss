# Release: Agentic Right-Click Context Menu — Phase 1a

> **Date:** 2026-01-30
> **Status:** Complete
> **Feature:** CORE-FEATURE-agentic-right-click-context-menu

## What was done

Replaced Electron's default right-click menu on user messages with a custom Radix-based context menu. All menu items are disabled placeholders — the UI shell is complete, actions will be wired in subsequent phases.

## Menu items

| Item | Icon | Group | Wired in |
|------|------|-------|----------|
| Edit & Resend | Pencil | Editing | Phase 1b |
| Retry | RefreshCw | Editing | Phase 1b |
| Rephrase... | Sparkles | AI-powered | Phase 2 |
| Create Group... | Users | AI-powered | Phase 3 |
| Branch from Here | GitBranch | Structural | Phase 1c |
| Copy | Copy | Utility | Phase 1a (next) |

## Files modified

| File | Change |
|------|--------|
| `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` | Added context menu imports (Radix + lucide icons), wrapped user message turn block with `<ContextMenu>` + `<ContextMenuTrigger>`, added all placeholder menu items with separators |

## Technical details

- Uses existing `styled-context-menu.tsx` components — no new component files
- Menu disabled when `session.isProcessing`, `message.isPending`, or `message.isQueued`
- `ContextMenuTrigger` uses `asChild` so the existing div structure is preserved
- `key` moved from inner div to outer `<ContextMenu>` for correct React reconciliation
- Typecheck: zero new errors introduced

## What's NOT included

- No actions are functional — all items have `disabled` prop
- No IPC commands, event processor changes, or SessionManager methods
- No keyboard shortcuts on menu items yet
