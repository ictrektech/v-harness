---
description: "The web client's knowledge-base surface: an @ source that scopes the next prompt to one company knowledge base, the source strip under an answer, and an evidence page that shows the passages retrieved."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-knowledge

English | [中文](README.zh.md)

## Summary

Three surfaces, one gateway:

- **`@` source.** Typing `@` lists the knowledge bases the signed-in user can see, plus an "all knowledge bases" row; picking one inserts an atomic reference whose model-side text is `<knowledge-base>name</knowledge-base>`. The `weknora` skill reads that name and passes it as `--kb`.
- **Source strip.** After a closing answer, each passage the turn actually retrieved becomes one chip. Clicking a chip opens the evidence page on that turn's passages with the clicked one focused.
- **Evidence page.** A right-column page type that searches the same libraries on its own, and that opens pre-filled when it arrives from a chip.

The rows, the search, and the passages come from the gateway, not from a host service: `GET /__vh/weknora/api/v1/knowledge-bases` and `POST /__vh/weknora/api/v1/knowledge-search` forward the page's own cookie session to WeKnora with the user's VOS token attached. Neither the browser nor the agent handles a knowledge-base credential, and every surface shows exactly what that user may read.

## What it registers

- **The source** — `ctx.inputTriggers.registerSource(...)` with `trigger: '@'`, `name: 'knowledge'`, `order: 10`, `showGroupTitle: false`, one section label from the `knowledge` namespace, and a `codec` that serializes `*` or a library name into `<knowledge-base>…</knowledge-base>`.
- **The rows** — the "all knowledge bases" row always, then every visible library whose name contains the typed query. Filtering is case-insensitive substring matching: users search by name, not by path.
- **The turn data** — a `knowledge` Conversation Definition folding this turn's `tool/result` events into `ConversationTurnDataMap`, so the strip reads facts the Session already logged rather than re-querying the service.
- **The strip** — one `conversation.chat.turnTail` entry that renders nothing for a turn that retrieved no passage.
- **The page type** — `evidence` in `ctx.sidebarRightTabs`, plus its body and title in `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`.
- **The dictionaries** — the `knowledge` namespace into `ctx.locale`.

## How citations are derived

Only the two JSON shapes the `weknora` skill prints are read: `search`'s `citations` array and `read`'s `chunks` array beside its `knowledge` header. Each chunk id becomes at most one chip, in first-seen order, and only settlements before the closing answer count.

Nothing is inferred from the prose. A model that names a passage it never retrieved, or a tool result that mentions a chunk without the skill's payload, produces no chip — the strip tells the reader what the run saw, not what it said.

## How it fails

A gateway that cannot list libraries leaves the "all knowledge bases" row in place. That is deliberate: the pick still means "ask the knowledge service", and the `weknora` skill reports the real reason (service down, token expired, or no library assigned) instead of the menu guessing at one.

A failed listing is not cached, so a service that comes back appears on the next keystroke without a reload. The evidence page reports an unreadable library list on its own status line and searches every visible library meanwhile; a failed search replaces the list with one line instead of an empty result.

## Known Limitations

- The listing is cached for the life of the page; a library created elsewhere appears after a reload.
- Picking a library only states a scope. Nothing prevents the model from searching elsewhere, so the skill's `--kb` remains advisory.
- The strip reads the skill's printed payload. A skill run whose output is truncated before its JSON ends contributes no chip.
