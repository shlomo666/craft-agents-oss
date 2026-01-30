# CORE FEATURE: User Message Dialogue

> The right-click menu on user messages becomes a living dialogue — not a static menu, but an intelligent surface that thinks, suggests, and acts. Every interaction is faster than typing. Every option is relevant. The menu itself becomes the preferred way to interact with AI.

---

## Vision

When you right-click a user message, you don't get "Cut / Copy / Paste." You get a **dialogue** — a menu that understands your message, your context, your history, and offers actions that are so useful you'd rather click than type. Over time, the menu items themselves are AI-curated, sorted by relevance, and expanding with new capabilities. The menu becomes alive.

---

## Roadmap

### Phase 1: The Context Menu (foundation)

The context menu is broken into sub-phases. The menu itself is the foundation everything else builds on.

#### Phase 1a: The Menu Itself

Replace Electron's default right-click menu ("Inspect Element / Cut / Copy / Paste") with a custom Radix-based context menu on user messages. No actions yet — just the menu appearing, looking right, and not breaking anything.

**Tasks:** See `docs/tasks/agentic-right-click-context-menu-phase1a.md`

**Scope:**
- Custom context menu appears on right-click of any user message
- Placeholder items (disabled) showing where future actions will go
- Default Electron menu is suppressed for user message bubbles
- Menu is disabled during processing / on pending messages
- Looks consistent with existing styled context menus in the app

#### Phase 1b: Rewind (Edit & Resend)

First real action in the menu. Truncates conversation at a message, pre-fills input.

**Scope:**
- `rewind` SessionCommand + IPC handler + SessionManager method
- Event processor: `session_rewound` event + `prefill_input` effect
- App.tsx wires effect to set draft + focus input

#### Phase 1c: Branch from Here

Second action. Clones conversation into a new session.

**Scope:**
- `branch` SessionCommand + IPC handler + SessionManager method
- Event processor: `session_branched` event + `branch_created` effect
- App.tsx wires effect to add session, navigate, set draft

**What we already know works (from first implementation attempt):**
The full pipeline for 1b+1c was wired end-to-end in a previous attempt. Summary:

| Layer | What was done | Files |
|-------|---------------|-------|
| Shared types | Added `rewind`/`branch` to `SessionCommand`, added `session_rewound`/`session_branched` to `SessionEvent` | `apps/electron/src/shared/types.ts` |
| Event processor types | Added `SessionRewoundEvent`, `SessionBranchedEvent`, `prefill_input` and `branch_created` effects | `apps/electron/src/renderer/event-processor/types.ts` |
| Event handlers | `handleSessionRewound` (truncates messages, returns prefill effect), `handleSessionBranched` (returns branch_created effect) | `apps/electron/src/renderer/event-processor/handlers/session.ts` |
| Processor | Added switch cases for `session_rewound` and `session_branched` | `apps/electron/src/renderer/event-processor/processor.ts` |
| SessionManager | `rewindToMessage()` — finds message, aborts if processing, truncates, clears sdkSessionId/agent, persists, emits event. `branchFromMessage()` — creates new session, copies messages up to target, persists, emits event with new Session object | `apps/electron/src/main/sessions.ts` |
| IPC | Added `rewind` and `branch` cases to sessionCommand handler | `apps/electron/src/main/ipc.ts` |
| App.tsx effects | `prefill_input` — sets draft via `sessionDraftsRef`, calls `setDraft`. `branch_created` — adds session via `store.set(addSessionAtom)`, sets draft, navigates | `apps/electron/src/renderer/App.tsx` |
| ChatDisplay UI | Wrapped user message `<div>` with `<ContextMenu>` + `<ContextMenuTrigger>`, two `StyledContextMenuItem`s with Pencil and GitBranch icons, disabled when `isProcessing`/`isPending`/`isQueued` | `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` |

All changes were reverted to start clean, but the design is validated.

---

### Phase 2: Rephrase (AI-powered suggestions)

The first AI-powered menu item. When selected, it calls Sonnet with extended thinking to generate alternative phrasings of the user's message.

**UX flow:**
1. Right-click message -> "Rephrase..."
2. A loading state appears (this takes a few seconds — thinking model)
3. Returns 3-5 suggestions, each shown as a one-sentence summary
4. Each summary is expandable or clickable to reveal the full rephrased message
5. Clicking a suggestion triggers a rewind + resend with the new phrasing

**Technical:**
- New IPC command: `rephrase` with `messageId`
- Backend calls Sonnet (with thinking) passing the message + conversation context
- Returns structured suggestions: `{ summary: string, fullText: string }[]`
- UI: popover or inline panel below the context menu
- Reuses rewind infrastructure from Phase 1

**Implementation shortcut — copycat "Regenerate Title":**
Craft Agent already has a "Regenerate Title" feature in the session list context menu (right-click a conversation → Regenerate Title). This feature has the exact UX pattern we need for all AI-powered menu actions:
- **Fade in/out animation** on the session title while the AI is thinking
- **Loading state** that shows the item is "in progress" without blocking the UI
- **Toast notification** that briefly confirms success (auto-dismisses after ~1 second)
- **Same async pattern**: trigger action → show progress → replace content → toast

For Rephrase (and later Create Group, and any future AI menu actions), we should **replicate this exact pattern** rather than designing a new UX from scratch. The animation, toast, and async state management are already battle-tested in the codebase. Just adapt them for message content instead of session titles.

---

### Phase 3: Create Group (AI-powered team assembly)

Uses the same AI suggestion infrastructure as Rephrase, but for a different purpose: intelligently assembling a "team" of perspectives or approaches for a task.

**UX flow:**
1. Right-click message -> "Create Group..."
2. AI analyzes the message/task and suggests groups of 2-3 complementary approaches or expert perspectives
3. Each group is presented as a titled set (e.g., "Architect + Devil's Advocate", "Researcher + Implementer + Reviewer")
4. User picks a group, and the message is resent with that framing injected
5. An "!" or "?" icon lets the user preview the full prompt that will be sent

**Technical:**
- Shares the AI suggestion backend with Rephrase (same IPC pattern, different prompt)
- Suggestions are structured: `{ title: string, members: string[], description: string, fullPrompt: string }[]`
- Preview mode shows the complete prompt before sending

---

### Phase 4: Living Menu (AI-curated actions)

The menu stops being a static list. It becomes dynamically sorted and filtered by an AI that understands what's most relevant right now.

**Concept:**
- Every menu item is a registered "skill" with metadata (name, description, when-to-use)
- On right-click, a fast model (Haiku) scores each skill against the current message + context
- Menu items are sorted by relevance score, with the most useful actions at the top
- Low-relevance items are collapsed into a "More..." submenu
- New skills can be added without changing the menu code — they self-register and get ranked automatically

**Technical:**
- Skill registry: each action declares its metadata and trigger conditions
- Scoring: fast model call on right-click (must be <500ms for UX)
- Caching: score results cached per message (invalidated on context change)
- Extensibility: plugins/skills can register new menu items

---

### Phase 5+: The Endless Menu

> "You have suggestions over suggestions... the features themselves will be so many that we would ask an agent to search semantically for the most relevant features."

At this point the menu becomes a **search surface**:
- Typing in the menu filters actions semantically, not just by name
- Community-contributed skills appear alongside built-in ones
- The menu learns from usage patterns — actions you use often float to the top
- Cross-message actions: "Compare with previous version", "Summarize thread so far", "Extract action items from conversation"
- Assistant message actions: copy, regenerate, rate, fork from response, save as template

---

## Principles

1. **Click over type** — Every menu action should be faster than explaining what you want in text
2. **AI behind the scenes** — The user clicks, the AI works. No prompting required.
3. **Progressive complexity** — Start with 2 items, grow to hundreds. The ranking keeps it manageable.
4. **Pre-programmed skills** — Each action is a well-tested skill, not a freeform prompt. Reliability over flexibility.
5. **Lean per phase** — Ship each phase independently. Don't block Phase 1 on Phase 4 dreams.

---

## Current Status

| Phase | Status | Release | Notes |
|-------|--------|---------|-------|
| Phase 1a: Context Menu UI | **Complete** | [`phase1a`](releases/agentic-right-click-context-menu-phase1a.md) | All 6 menu items rendered, disabled placeholders |
| Phase 1b: Rewind | **Complete** | [`phase1b`](releases/agentic-right-click-context-menu-phase1b.md) | Edit & Resend + Copy wired, inline editor UI |
| Assistant: Retry + Copy | **Complete** | — | Right-click assistant messages: Retry (rewind+resend) + Copy. See [`tasks/assistant-context-menu-retry.md`](tasks/assistant-context-menu-retry.md) |
| Phase 1c: Branch | **Next up** | — | Design validated, rewind infra reusable |
| Phase 2: Rephrase | Designed | — | Copycat "Regenerate Title" UX pattern (fade, toast, async) |
| Phase 3: Create Group | Designed | — | Shares infra with Phase 2 + same Regenerate Title pattern |
| Phase 4: Living Menu | Concept | — | Needs skill registry design |
| Phase 5+: Endless Menu | Vision | — | Long-term north star |
