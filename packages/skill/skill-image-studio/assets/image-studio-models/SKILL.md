---
name: image-studio-models
description: Inspect Image Studio model capabilities and readiness, download or stop weights, choose quantized variants, and plan low-VRAM settings.
---

# Prepare Image Studio models

The CLI paths and service endpoint come from the runtime block. Pass `--base-url` and `--auth-file` unless the environment already provides them.

## Inspect the catalog

```bash
"<node>" "<cli>" ... models --ready
"<node>" "<cli>" ... models --capability txt2img
"<node>" "<cli>" ... models --capability img2img,edit
"<node>" "<cli>" ... model qwen-image
```

Capabilities are `txt2img`, `img2img`, `edit`, and `video`. Several `--capability` filters use AND semantics. Each row reports `status` (`ready`, `missing`, `downloading`, `failed`, `unknown`), `size`, `progress`, and `variants`. Without `--ready` the catalog also lists entries that still need a download.

Only the `key` field goes into `--model-key`; a `variants[].id` goes into `--model-variant`.

## Download and stop

```bash
"<node>" "<cli>" ... pull sd35
"<node>" "<cli>" ... pull qwen-image --variant q4_k_m
"<node>" "<cli>" ... pull flux-schnell --force
"<node>" "<cli>" ... stop flux-schnell
```

Pulling returns immediately and downloads in the background; families are multi-file and may take 4–70 GB. Poll with `model <key>` until `status` is `ready`; when the user has not asked to wait, report progress and let them decide. `--force` restarts an existing download. `stop` keeps the partial files for a later resume. Never start a second pull for the same key.

## Variants and constrained hardware

Variants are quantized or alternate repositories under the same base key. Prefer one when the host has limited VRAM or the full-precision weights are not downloaded.

For low memory, in order: pick a quantized variant, reduce `--width`/`--height`, `--steps`, `--video-frames`, then enable `--vae-tiling`, `--temporal-tiling`, `--stream-layers`, and `--vae-cpu-fallback` for video. `--offload-to-cpu` trades speed for memory and stays off unless accepted.

## Remote models

Models whose key starts with `v-router/` are served by V-Router instead of local weights. They appear after the service has a V-Router connection; use them only when the user names one or asks for a cloud model. Local generation and remote generation share the same job and output flow.

If the catalog request fails, report the service as unavailable and stop. Do not infer model names, capabilities, or readiness from memory.
