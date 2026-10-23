# Agent Note: Client Inline Marks for Cited Prose

Status: implemented

English | [中文](2026-10-23-client-inline-marks.zh.md)

## Problem

A retrieval answer that cites passages had no way to point at them from inside a sentence. The knowledge surface could list the passages a Turn retrieved under the reply, and the skill instructed the model to name each source in prose — 「《员工考勤与假期管理制度》#3」 — because there was nothing else it could write. The reader consequently had two jobs: parse document names out of running text, and count rows under the answer to find the one that sentence meant. Neither the name nor the count was machine-checkable, so a model could cite a document it never retrieved and no surface would disagree.

The chat body is the one place that cannot fix this alone. `MarkdownText` renders untrusted Markdown directly from mdast to React, keeps raw HTML literal, and exposes vocabulary at exactly two points — `fileMentions` for inline code, `pathImages` for image destinations. Prose runs have no equivalent hook, and tool-card seats (`tool.call.toolview`) are the wrong shape: they key by wire tool name, while a citation lives inside the answer text.

Writing HTML from the skill was the tempting answer and is not available. The renderer draws raw HTML as literal text on purpose, and arbitrary model-authored markup would bypass locale dictionaries and design tokens — a cost every chat product pays the same way, ChatGPT included, by rendering a fixed component set instead.

## Decision

`ui-primitives` carries a prose vocabulary. `MarkdownInlineMarks.resolve(text, key)` receives one text run and returns replacement nodes or `undefined`; the renderer calls it in the `text` case only, skips it inside anchors (a mark that opens a source cannot nest in a link), and skips it for streaming passes. With no vocabulary supplied the rendered DOM is unchanged, which is what the pinned `markdown-dom` fixtures assert.

`ui-chat` exposes that vocabulary as an optional service rather than a slot. `ctx.chatInlineMarks.forClosing(owner)` mirrors `ctx.chatFileMentions.forClosing(owner, sessionId)` exactly: it is read at the view inject face, delivered to node owner props as `inlineMarks(owner)`, and evaluated only for the closing Assistant of a closed Turn. Composition is the on switch — a deployment without the provider keeps every run literal.

`ui-knowledge` provides it. A mark's number is the position of its passage in the same array the source card renders, so the sentence and the row are one fact read once. A number the Turn did not retrieve stays literal text: the vocabulary never invents a mapping, so `[7]` in an answer with three passages renders as the characters the model wrote.

Marks are badges, not controls. They carry the document title and passage position as their tooltip; the numbered row under the answer is the opener, and `SourceCards` owns that disclosure.

## Numbering is a position, not a label

The upstream search API offers no ordering control. `POST /api/v1/knowledge-search` accepts `query`, knowledge base and document ids, tag and mention filters, two recall thresholds, `match_count`, two recall switches, and a rerank object; its order is fixed by the server's recall → rerank → merge → truncate pipeline. A client that wanted document-name ordering would sort after the fact and break the correspondence with the order the model was told to count.

So the position is the contract. The skill instructs the model to number by position in the `citations` array, deduplicated in first-seen order across a Turn's searches; `turn.ts` accumulates exactly that sequence; the card renders its index plus one; `marks.ts` resolves the same index. One array, three readers, no second derivation.

## Why settled-only

`fileMentions` and `pathImages` already skip streaming passes because a frozen block caches the element it rendered and must not bake in a vocabulary that is still growing. Marks inherit the rule instead of inventing an exemption: during streaming `[1]` is text, and it becomes a badge when the message settles. The alternative — marking the streaming tail only — would produce two renderings of one sentence and a visible reflow at settlement.

## Alternatives considered

**Let the model emit HTML or CSS.** Rejected: raw HTML draws as literal text by design, and model-authored markup would carry its own colors, spacing, and copy past the locale dictionaries and the design tokens. The same reasoning that keeps tool cards in the client keeps prose marks there too.

**Render citation markers as Markdown links to the passage.** Rejected: link destinations pass a protocol allowlist, so a custom scheme is inert; a file or HTTP link also changes what the answer says and what the session log records, and a mid-sentence anchor restyles the text as a link rather than a mark.

**Post-process the rendered DOM, or rewrite the Markdown source before rendering.** Rejected: the session log is the source of truth for what the model said, so rewriting source makes the log disagree with the screen; DOM post-processing fights both React reconciliation and the incremental renderer's frozen blocks.

**A dedicated `weknora` tool with a `tool.call.toolview` card.** Rejected for this change: the repository deliberately keeps knowledge access as a CLI skill, and a tool card still cannot place a marker inside a sentence. Converting retrieval into a Host tool is a separate decision with its own cost.

**A second client registry for prose decoration.** Rejected: the client-derived tool-presentation note forbids a parallel presenter registry, and the existing optional-service face already carries the same per-Turn, composition-switched semantics.

**Clickable badges that expand the passage in place.** Deferred, not rejected: the card below already owns the disclosure, and a second opener inside running text competes with text selection and needs turn-scoped focus state shared across two components. The badge keeps the tooltip, which names the source without claiming an action.

## Consequences

The Chat node owner props gain a required `inlineMarks` field, so every seat that constructs them — view, flow, node seat, and the test fixtures that build them by hand — carries one more line. The alternative was an optional field with a `?.` call, which hides the difference between "this build has no provider" and "this plugin forgot to thread it"; the composition switch is already expressed by the service being absent.

Marks appear at settlement rather than during streaming, so a reader watching a long answer sees literal `[1]` until the Turn closes. The source card has the same timing, so the two surfaces still appear together.

The answer no longer carries document names in prose, which shortens it and removes the characters a reader had to skip; in exchange the answer depends on the client to render its sources, and a client without this plugin shows the bare numbers. That is the same degradation an unresolved `fileMentions` token already has, and it is visible rather than wrong.

Coverage: `markParts` unit tests pin the split (position in range, unretrieved number literal, mixed run, adjacent markers, no marker, empty retrieval); `ui-primitives` tests pin the vocabulary contract (default absent, declined run, inside a link, streaming pass); `ui-chat` pins that only the closing prose receives the vocabulary, with the closing Turn's own owner currency; the pinned `markdown-dom` fixtures are unchanged, which is the evidence that the default path still emits the DOM it always did.
