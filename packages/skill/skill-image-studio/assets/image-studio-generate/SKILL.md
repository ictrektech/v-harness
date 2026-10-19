---
name: image-studio-generate
description: Create images or videos, edit an existing image, batch variations, and continue from earlier outputs through Image Studio jobs.
---

# Generate images and videos

Run the CLI through the shell with the absolute Node and CLI paths supplied in the runtime block. Pass `--base-url` and `--auth-file` from that block unless the environment already provides `IMAGE_STUDIO_BASE_URL` and `IMAGE_STUDIO_AUTH_FILE`.

A job is created immediately (`queued`) and runs in the background. `--wait` polls until it finishes and downloads the outputs:

```bash
"<node>" "<cli>" --base-url <baseUrl> --auth-file <authFile> generate \
  --prompt "a quiet tea house by the lake, morning mist" \
  --model-key sdxl --width 1024 --height 1024 --wait
```

The result is JSON with `job_id`, `status`, `seed`, `outputs`, `directory`, and `files`. Read `files[].path` with the image-reading tool before describing the result. For a video, report the path instead of reading it as an image.

## Model choice

`sd15` and `sdxl` are safe defaults for text-to-image. Choose by requirement, then verify availability with `image-studio-models`:

- Reference image or instruction editing: a model whose capabilities include `img2img` or `edit`, for example `qwen-image-edit`, `flux-kontext`, `longcat-image-edit`, `boogu-image-edit`, or `mage-flow-edit`.
- Video: `wan21`, `wan21-t2v-14b`, `wan22`, `ltx-video`, `hunyuan-video`, `hunyuan-t2v-480p`, or a family that accepts a first frame.
- Quantized or low-VRAM weights: pass `--model-variant q4_k_m` (or the exact id from `GET /api/v1/models`).

A `409 模型文件未就绪` means the weights are missing: load `image-studio-models` and pull the model instead of switching to an unrelated one.

## Reference images and iteration

- New reference image: `--input <absolute-file>` uploads it and sets `init_input_id` automatically.
- Reuse an earlier output: `--init-job <job_id> --init-filename output.png`.
- Editing keeps the source composition only when the model supports references; other models silently ignore these fields, so check capabilities first.

```bash
"<node>" "<cli>" ... generate --prompt "make it a snowy night" \
  --model-key qwen-image-edit --input /path/ref.png --strength 0.8 --wait
```

## Parameters

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

## Inspecting and follow-up

```bash
"<node>" "<cli>" ... status <job_id>
"<node>" "<cli>" ... jobs --limit 10
"<node>" "<cli>" ... download <job_id> --out <task-directory>
"<node>" "<cli>" ... cancel <job_id>
```

`status` reports `progress`, `outputs`, and `error`. A failed job keeps its error text: report it, adjust parameters only when the cause is clear, and do not resubmit the identical request. `cancel` deletes the job and its files, so never cancel a job whose outputs are still needed.
