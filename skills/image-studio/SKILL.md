---
name: image-studio
description: Generate, edit, or animate images with the local Image Studio service, and prepare model weights when one is missing.
---

# Image Studio

Image Studio is a self-hosted generation service on the local network. It runs jobs asynchronously and stores every output under the calling account.

When the `image_studio_generate` tool is available, prefer it for a single image: it opens a parameter form the user confirms, then runs the CLI with the accepted values. Use this skill directly for reference images, videos, batching, or model preparation.

## Runtime

The CLI ships with this skill. These are the defaults; the environment may override them:

| Setting | Default | Override |
|---|---|---|
| CLI | `/opt/v-harness/skills/image-studio/scripts/image-studio.mjs` | `IMAGE_STUDIO_CLI` |
| Base URL | `http://image-studio-backend:5000` | `IMAGE_STUDIO_BASE_URL` |
| Auth file | `~/.config/dsh/image-studio.json` | `IMAGE_STUDIO_AUTH_FILE` |

Invoke through the shell:

```bash
node "${IMAGE_STUDIO_CLI:-/opt/v-harness/skills/image-studio/scripts/image-studio.mjs}" \
  --base-url "${IMAGE_STUDIO_BASE_URL:-http://image-studio-backend:5000}" \
  --auth-file "${IMAGE_STUDIO_AUTH_FILE:-$HOME/.config/dsh/image-studio.json}" <command>
```

Authentication lives in the auth file; never print or pass its token to the model.

## Baseline flow

1. Check the model is ready with `models --ready`; if its weights are missing, see [Prepare models](#prepare-models).
2. Submit the job with `--wait`, which polls until it finishes and downloads the outputs.
3. Inspect downloaded images with the image-reading tool before describing them; never guess what was rendered.
4. Report the prompt, model, seed, and absolute output paths.

## Generate images and videos

A job is created immediately (`queued`) and runs in the background. `--wait` polls until it finishes and downloads the outputs:

```bash
node "${IMAGE_STUDIO_CLI:-/opt/v-harness/skills/image-studio/scripts/image-studio.mjs}" \
  --base-url "${IMAGE_STUDIO_BASE_URL:-http://image-studio-backend:5000}" \
  --auth-file "${IMAGE_STUDIO_AUTH_FILE:-$HOME/.config/dsh/image-studio.json}" generate \
  --prompt "a quiet tea house by the lake, morning mist" \
  --model-key sdxl --width 1024 --height 1024 --wait
```

The result is JSON with `job_id`, `status`, `seed`, `outputs`, `directory`, and `files`. Read `files[].path` with the image-reading tool before describing the result. For a video, report the path instead of reading it as an image.

### Model choice

`sd15` and `sdxl` are safe defaults for text-to-image. Choose by requirement, then verify availability with `models --ready`:

- Reference image or instruction editing: a model whose capabilities include `img2img` or `edit`, for example `qwen-image-edit`, `flux-kontext`, `longcat-image-edit`, `boogu-image-edit`, or `mage-flow-edit`.
- Video: `wan21`, `wan21-t2v-14b`, `wan22`, `ltx-video`, `hunyuan-video`, `hunyuan-t2v-480p`, or a family that accepts a first frame.
- Quantized or low-VRAM weights: pass `--model-variant q4_k_m` (or the exact id from `models`).

A `409 模型文件未就绪` means the weights are missing: pull the model instead of switching to an unrelated one.

### Reference images and iteration

- New reference image: `--input <absolute-file>` uploads it and sets `init_input_id` automatically.
- Reuse an earlier output: `--init-job <job_id> --init-filename output.png`.
- Editing keeps the source composition only when the model supports references; other models silently ignore these fields, so check capabilities first.

```bash
node "$IMAGE_STUDIO_CLI" ... generate --prompt "make it a snowy night" \
  --model-key qwen-image-edit --input /path/ref.png --strength 0.8 --wait
```

### Parameters

Keep the service defaults unless the user asks otherwise. Common options:

| Flag | Meaning |
|---|---|
| `--negative-prompt` | What to avoid |
| `--width` / `--height` | 256–2048, multiples of 8 preferred |
| `--steps` / `--cfg-scale` / `--sampler` | Sampling controls |
| `--seed` | `-1` random; a fixed value reproduces a result |
| `--batch-count` | 1–4 outputs in one job |
| `--strength` | Reference influence for img2img, 0–1 |
| `--video-frames` / `--fps` | Video length and rate (0 uses the family default) |
| `--vae-tiling` / `--temporal-tiling` / `--max-vram` | Low-VRAM execution |

Add `--timeout 7200` for long video jobs; the default wait is 1800 seconds.

### Inspecting and follow-up

```bash
node "$IMAGE_STUDIO_CLI" ... status <job_id>
node "$IMAGE_STUDIO_CLI" ... jobs --limit 10
node "$IMAGE_STUDIO_CLI" ... download <job_id> --out <task-directory>
node "$IMAGE_STUDIO_CLI" ... cancel <job_id>
```

`status` reports `progress`, `outputs`, and `error`. A failed job keeps its error text: report it, adjust parameters only when the cause is clear, and do not resubmit the identical request. `cancel` deletes the job and its files, so never cancel a job whose outputs are still needed.

## Prepare models

### Inspect the catalog

```bash
node "$IMAGE_STUDIO_CLI" ... models --ready
node "$IMAGE_STUDIO_CLI" ... models --capability txt2img
node "$IMAGE_STUDIO_CLI" ... models --capability img2img,edit
node "$IMAGE_STUDIO_CLI" ... model qwen-image
```

Capabilities are `txt2img`, `img2img`, `edit`, and `video`. Several `--capability` filters use AND semantics. Each row reports `status` (`ready`, `missing`, `downloading`, `failed`, `unknown`), `size`, `progress`, and `variants`. Without `--ready` the catalog also lists entries that still need a download.

Only the `key` field goes into `--model-key`; a `variants[].id` goes into `--model-variant`.

### Download and stop

```bash
node "$IMAGE_STUDIO_CLI" ... pull sd35
node "$IMAGE_STUDIO_CLI" ... pull qwen-image --variant q4_k_m
node "$IMAGE_STUDIO_CLI" ... pull flux-schnell --force
node "$IMAGE_STUDIO_CLI" ... stop flux-schnell
```

Pulling returns immediately and downloads in the background; families are multi-file and may take 4–70 GB. Poll with `model <key>` until `status` is `ready`; when the user has not asked to wait, report progress and let them decide. `--force` restarts an existing download. `stop` keeps the partial files for a later resume. Never start a second pull for the same key.

### Variants and constrained hardware

Variants are quantized or alternate repositories under the same base key. Prefer one when the host has limited VRAM or the full-precision weights are not downloaded.

For low memory, in order: pick a quantized variant, reduce `--width`/`--height`, `--steps`, `--video-frames`, then enable `--vae-tiling`, `--temporal-tiling`, `--stream-layers`, and `--vae-cpu-fallback` for video. `--offload-to-cpu` trades speed for memory and stays off unless accepted.

### Remote models

Models whose key starts with `v-router/` are served by V-Router instead of local weights. They appear after the service has a V-Router connection; use them only when the user names one or asks for a cloud model. Local generation and remote generation share the same job and output flow.

## Boundaries

- One generation may queue behind another; a video can take up to an hour. Do not retry while a job is running.
- If the service is unreachable, report that plainly and stop; do not start another client or install a different renderer.
- Do not infer model names, capabilities, or readiness from memory; read the catalog.
