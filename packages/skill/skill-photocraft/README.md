# @deepseek-ai/dsh-skill-photocraft

Natural-language photo editing over the per-tenant PhotoCraft capability: open a
photo from the chat attachment or the user's VOS directory, run a recipe (grade,
cutout, watermark removal, quality repair, poster title), look at the preview,
then export the result as PSD or JPG.

## Summary

- Two tools: `photocraft_edit` (open, pick the recipe from the user's own words,
  run it, save a PNG, return a preview) and `photocraft_export` (a PSD or JPG of
  the current document).
- No credential handling: the gateway (`gateway/photocraft.mjs`) holds the
  tenant's VOS token and exposes a unix socket the tenant owns.
- Every image-changing tool returns a preview as a durable attachment, so the
  model can look at its own work.

## Use this package

Listed in `gateway/agent-plugins/plugins.txt` and mounted by the carrier patch:

```yaml
- id: skill-photocraft
  name: '@deepseek-ai/dsh-skill-photocraft'
  disabled: !!js "!!process.env.VH_PHOTOCRAFT_OFF"
```

Configuration (all optional):

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `unix:$HOME/.dsh/photocraft.sock` | capability endpoint; an absolute `http(s)://` URL targets the dev server |
| `previewSide` | `768` | long edge of the preview handed to the model |
| `requestTimeoutMs` | `300000` | per-call deadline |

## Understand the implementation

- `src/client.ts` — MCP over Streamable HTTP (JSON or SSE replies, session id
  kept) and the file bridge (`volumes`/`upload`/`download`/`index`/`new_folder`).
  `EngineClient` and `BridgeClient` are the faces the recipes and tools consume, so
  their tests need no socket.
- `src/recipes.ts` — the wish catalogue, as code rather than data: a recipe feeds
  one step's returned layer id into the next step.
- `src/coords.ts` — `0..1` fractions in, pixels out. The composer's `<region/>`
  tags are read by the model, not parsed here; the tool only takes the `regions`
  and `strokes` arrays.
- `src/tools.ts` — the two tool definitions and their cards.

## Model Experience

The model sees two tools whose descriptions name the wishes they answer, plus a
`SKILL.md` that carries the workflow and the traps. The catalogue keeps a 918
command engine from being dumped into the prompt: the instruction picks one
recipe, and a call returns a preview next to the file it saved, so verification
is visual rather than textual.

Previews are attachments, not base64 in the transcript, so a long editing session
does not grow the text history. Each call adds one image to the turn; iterating
at the default 768 keeps a two-round edit within a few hundred kilobytes.

#### KV Cache effect

Tool definitions are static, so the system prefix stays cacheable across turns.
Preview images are appended as turn content rather than rewriting earlier
messages.

## Known Limitations and Deferred Work

- **No generative editing.** PhotoCraft has no ML runtime: object insertion,
  face replacement and outpainting are unavailable; `SKILL.md` routes them to
  Image Studio.
- **Coordinates come from the model or the user.** The composer region picker
  (`ui-attachment`) emits `<region/>` tags that the model transcribes into
  `regions`/`strokes`; a transcription error erases the wrong area.
- **No face detection.** `select.colorRange` rejects `detectFaces`; skin
  smoothing works on a colour range only.
- **`select.sky` is unreliable on painted or heavily textured skies** and reports
  `changed: false` rather than guessing.
- **One document per conversation.** Opening another file replaces the active
  document; there is no multi-document workspace in the tools yet.
- **Batch variants are dormant.** `poster` can export a data set, but no tool
  parameter feeds `variants` and the exported files are never read back, so the
  wish "批量出几套文案" is refused instead of half-answered.
- **No album access.** The tools neither read nor write the AI album; a picture
  reaches them as a chat attachment or a file in the workspace.
