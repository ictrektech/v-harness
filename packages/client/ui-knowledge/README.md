---
description: "The web client's knowledge-base surface: an @ scope pick that narrows the next question to a library, the citation strip under an answer, and an evidence page that shows and expands the passages retrieved."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-knowledge

English | [中文](README.zh.md)

## Summary

Search the company knowledge bases from the conversation. Typing `@` lists the libraries the signed-in user can see and inserts the picked one as a scope chip, so the next question carries its own narrowing instead of relying on the model to remember it. Every passage a run retrieves becomes a chip under the answer; clicking one opens the evidence page on that passage, where it expands to the full text and can be sent back to the composer. Choose it when answers must cite internal documents.

## Table of Contents

- [What it registers](#what-it-registers)
- [How citations are derived](#how-citations-are-derived)
- [How it fails](#how-it-fails)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The `@` source.** Typing `@` lists the libraries this account can see, plus a row that opens the panel. Picking a library inserts an atomic reference whose model-side text is `<knowledge-base>name</knowledge-base>`.
- **The reference node.** A message carrying that marker renders it as a chip, so the scope is visible in the user's own message and survives replay.
- **The source strip.** After a closing answer, each passage the turn actually retrieved becomes one chip. Clicking it opens the evidence page focused on that passage.
- **The evidence page.** A right-column page that browses libraries and documents, searches on its own, carries the checked libraries back to the composer (`Ask in N libraries`), and expands any passage to its full text before sending it back as a question.
- **The dictionaries.** The `knowledge` namespace into `ctx.locale`.

The rows, the searches, and the passages come from the gateway: `GET /__vh/weknora/api/v1/knowledge-bases`, `POST /__vh/weknora/api/v1/knowledge-search`, and `GET /__vh/weknora/api/v1/chunks/{id}` forward the page's own cookie session with the user's VOS token attached. Neither the browser nor the agent holds a knowledge-base credential, and every surface shows exactly what that user may read.

-----

<a id="how-citations-are-derived"></a>
## How citations are derived

The `weknora` skill prints one JSON object per call, and only the two shapes it prints are read: `search`'s `citations` array and `read`'s `chunks` array beside its `knowledge` header. A result carrying neither contributes nothing, so an unrelated command cannot invent a source, and a re-run of the same search stays one chip.

Nothing is inferred from the prose. A model that names a passage it never retrieved produces no chip — the strip tells the reader what the run saw, not what it said.

-----

<a id="how-it-fails"></a>
## How it fails

A gateway that cannot list libraries leaves the panel's list empty and the `@` menu with only its panel row. That is deliberate: the pick still means "ask the knowledge service", and the skill reports the real reason — service down, token expired, no library assigned — instead of the menu guessing at one.

A failed listing is not cached, so a service that comes back appears on the next keystroke without a reload. The evidence page reports an unreadable library list on its own status line and searches every visible library meanwhile; a failed search replaces the list with one line instead of an empty result.

-----

## Model Experience

### A scope marker in the user's own message

#### What the model sees

`<knowledge-base>name</knowledge-base>` inside the user message that picked the library. Nothing else: the strip, the panel, and the expansion are client surfaces with no prompt footprint.

#### Token effect

A few tokens per pick, bounded by the library name. Passages, citations, and panel state never enter a request.

#### KV Cache effect

None. The marker lives in a user message rather than the system prefix, and every client surface above it exists only after the turn ends.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The library list is cached for the life of the page; a library created elsewhere appears after a reload.
- Picking a library states a scope in the message. Nothing prevents the model from searching elsewhere, so the reference remains advisory.
- The strip reads what the skill printed. A run whose JSON never completed contributes no chip.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
