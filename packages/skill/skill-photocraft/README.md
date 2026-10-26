# @deepseek-ai/dsh-skill-photocraft

Natural-language photo editing over the per-tenant PhotoCraft capability: open a
photo from the user's VOS directory or AI album, run a recipe (grade, cutout,
watermark removal, quality repair, poster batch), look at the preview, export the
result — optionally back into the album.

## Summary

- Five tools: `photocraft_open`, `photocraft_recipe`, `photocraft_apply`,
  `photocraft_region`, `photocraft_export`.
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
| `albumEndpoint` | `unix:$HOME/.dsh/album.sock` | AI-album capability, the photo source and result sink |
| `previewSide` | `768` | long edge of the preview handed to the model |
| `requestTimeoutMs` | `300000` | per-call deadline |

## Understand the implementation

- `src/client.ts` — MCP over Streamable HTTP (JSON or SSE replies, session id
  kept), the file bridge (`volumes`/`upload`/`download`/`index`/`new_folder`), and
  the album multipart upload.
- `src/recipes.ts` — the wish catalogue, as code rather than data: a recipe feeds
  one step's returned layer id into the next step.
- `src/coords.ts` — `0..1` fractions in, pixels out, plus the `<region/>` parser
  the composer writes into a user message.
- `src/tools.ts` — the five tool definitions and their cards.

## Model Experience

The model sees five tools whose descriptions name the wishes they answer, plus a
`SKILL.md` that carries the workflow and the traps. The catalogue keeps a 918
command engine from being dumped into the prompt: `photocraft_recipe` narrows to
one recipe, and `photocraft_apply` returns per-command results next to a preview
image, so verification is visual rather than textual.

Previews are attachments, not base64 in the transcript, so a long editing session
does not grow the text history. Each call adds one image to the turn; iterating
at the default 768 keeps a two-round edit within a few hundred kilobytes.

#### KV Cache effect

Tool definitions are static, so the system prefix stays cacheable across turns.
Recipe text changes only between calls to `photocraft_recipe`, and preview images
are appended as turn content rather than rewriting earlier messages.

## Known Limitations and Deferred Work

- **No generative editing.** PhotoCraft has no ML runtime: object insertion,
  face replacement and outpainting are unavailable; `SKILL.md` routes them to
  Image Studio.
- **Coordinates come from the model or the user.** The composer region picker
  (`ui-attachment`) is not built yet, so a caller either passes a fraction box or
  relies on a semantic selection; a 120px error erases the wrong area.
- **No face detection.** `select.colorRange` rejects `detectFaces`; skin
  smoothing works on a colour range only.
- **`select.sky` is unreliable on painted or heavily textured skies** and reports
  `changed: false` rather than guessing.
- **One document per conversation.** Opening another file replaces the active
  document; there is no multi-document workspace in the tools yet.
- **Batch export directories must exist.** The capability exposes no mkdir, so
  `poster` creates `out/` through the file bridge and swallows the collision.
- **Album writing is one-way per call.** There is no album listing tool here yet;
  discovering an asset id is still the album skill's job.
