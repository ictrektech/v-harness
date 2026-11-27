---
name: image-studio
description: Generate, edit, or animate images with the local Image Studio service, prepare model weights, manage V-Scheduler compute nodes and Image Studio remote deployments.
---

# Image Studio

Image Studio is a self-hosted generation service on the local network. It runs jobs asynchronously and stores every output under the calling account.

When the `image_studio_generate` tool is available, prefer it for a single image: it opens a parameter form the user confirms, then runs the CLI with the accepted values. Use this skill directly for reference images, videos, batching, or model preparation.

When the tool answers `the user cancelled ask_user_question`, the dialog was dismissed before an answer arrived. Say so in one sentence and ask which parameter to change, or offer to reopen the form — **do not** switch to the CLI and generate anyway: the user closed the form, and bypassing it spends their GPU time on parameters they never approved.

## Runtime

The CLI ships with this skill. These are the defaults; the environment may override them:

| Setting | Default | Override |
|---|---|---|
| CLI | `/opt/v-harness/skills/image-studio/scripts/image-studio.mjs` | `IMAGE_STUDIO_CLI` |
| Endpoint | `~/.dsh/image-studio.sock`（由 v-harness 网关转发，沙箱内默认走它） | `VH_IMAGE_STUDIO_SOCK` |
| Base URL | `http://image-studio-backend:5000`，仅在 socket 不存在或 `IMAGE_STUDIO_FORCE_HTTP=1` 时使用 | `IMAGE_STUDIO_BASE_URL` |
| Auth file | `~/.config/dsh/image-studio.json` | `IMAGE_STUDIO_AUTH_FILE` |

Invoke through the shell:

```bash
node "${IMAGE_STUDIO_CLI:-/opt/v-harness/skills/image-studio/scripts/image-studio.mjs}" \
  --auth-file "${IMAGE_STUDIO_AUTH_FILE:-$HOME/.config/dsh/image-studio.json}" <command>
```

Authentication lives in the auth file; never print or pass its token to the model.

## Baseline flow

1. Check the model is ready with `models --ready`; if its weights are missing, see [Prepare models](#prepare-models).
2. Submit the job with `--wait`, which polls until it finishes and downloads the outputs.
3. Inspect downloaded images with the image-reading tool before describing them; never guess what was rendered. When the running model declares no image input, `read_image` refuses — then skip the inspection and deliver the file instead of retrying.
4. **照片必须出现在回复正文里**，两条路：
   - **走了 `image_studio_generate` 工具**：结果里有一个 `markdown` 字段（形如 `![output.png](image-studio-output/.../output.png)`，路径已按会话工作目录算好）——把这一行**原样**写进回复正文，再加一两句话收尾。不要改写路径、不要自己算、不要运行任何命令。
   - **走 CLI（没有工具）**：先用 `--out <目录>` 把图下载到**当前工作目录**下，再在正文写 `![文件名](相对当前目录的路径)`。不要写到工作区根目录去。

## Select a compute node

Run `placements` to list registered model placements. In the confirmation tool, pass `node_id` (display name or Scheduler node ID) and the model key when the user names a node. With the CLI, pass `--node-id` or `--compute-deployment-id` to `generate`. Preserve the requested placement when retrying. Read `scheduler_task_id` from the job to verify the actual node in V-Scheduler.

## Generate images and videos

A job is created immediately (`queued`) and runs in the background. `--wait` polls until it finishes and downloads the outputs:

```bash
node "${IMAGE_STUDIO_CLI:-/opt/v-harness/skills/image-studio/scripts/image-studio.mjs}" \
  --auth-file "${IMAGE_STUDIO_AUTH_FILE:-$HOME/.config/dsh/image-studio.json}" generate \
  --prompt "a quiet tea house by the lake, morning mist" \
  --model-key sdxl --width 1024 --height 1024 --wait
```

The result is JSON with `job_id`, `status`, `seed`, `outputs`, `directory`, and `files`. Read `files[].path` with the image-reading tool before describing the result. For a video, report the path instead of reading it as an image.

### Model choice

Never assume a model exists: this deployment may serve only one, and its name differs from any memory of "sd15/sdxl". Read the catalog first (`models --ready`) and choose from what it returns. Then pick by requirement:

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


## Compute nodes and remote model preparation

Use the tenant socket CLI at `/opt/v-harness/skills/image-studio/scripts/v-scheduler.mjs`. It forwards the current VOS identity. Listing needs a signed-in account, changes need a VOS administrator. Read `nodes`, `managed-nodes` and `backends` before choosing a target. Show the named target and requested change to the user and use their existing authorization.

- `add --json-file PATH` verifies and saves a connection. The JSON accepts `name`, `host`, `ssh_port` (default 22), `ssh_user` (default root), `auth_method` (password or key), `ssh_password` or `ssh_key`, optional `sudo_password`, and `profile`. Use the user-provided private file. Keep credentials out of command arguments and replies.
- `update ID --json-file PATH` updates supplied fields. Omit credentials to retain them. Empty `sudo_password` clears explicit sudo.
- `rescan ID` refreshes hardware. `runtime ID` runs the Scheduler's configured container test. `remove ID` removes the saved node configuration.
- `budget ID --json-file PATH` updates a scheduling node's budget. `approve ID --json-file PATH` approves a pending registration. The native NodeEdit JSON requires `version`, `display_name`, and `capacities`, with optional `resident_baseline`, `safety_reserve`, and `vos_member_id`. Read the current register first and preserve its version. `drain ID` pauses new scheduling, `resume ID` allows it again, and `revoke ID` revokes enrollment. A conflict requires rereading state.
- Accepted profiles are `jetson-thor`, `dgx-spark`, `jetson-orin`, `arm-cpu`, `amd-cpu`, `amd-cuda`, `arm-cuda`, and `sophon-bm1688`. Read the returned compatible profiles.

Use the Image Studio CLI above for the deployment workflow.

1. `compute` lists eligible targets, deployments and model preparations. Select a returned target.
2. `deploy-backend --kind ssh|cluster --node-id ID --request-key KEY` creates the backend. Preserve KEY on retry, then read `compute` until that deployment is running. Surface a failed state and `last_error`.
3. Check `models` and prepare local model weights first. Run `prepare-model DEPLOYMENT --model-key KEY [--model-variant VARIANT]`.
4. Poll `compute` until that model preparation is `registered`. Report `phase`, `received_bytes`, `total_bytes` and `weight_source`. The owner app checks a read-only Model Hub share first and copies verified files when needed. A `transferring` or `interrupted` state is incomplete. Retry `prepare-model` for an interrupted transfer.
5. Read `placements` and generate using the exact `--compute-deployment-id`. Verify the returned Scheduler task and node.
6. Use `backend-start`, `backend-stop`, or `backend-remove DEPLOYMENT` for its lifecycle. `remove-remote-model DEPLOYMENT --model-id KEY[@VARIANT]` unregisters that model and deletes its target weights. An active-model refusal must be resolved through the owning app before retrying.

A successful deployment receipt starts an asynchronous workflow. Read its state before claiming readiness. A 401 needs a refreshed VOS sign-in, 403 needs the owning service's administrator permission, 409 needs the current state to be resolved. Report the owner's error code.

## Persistent deliverables

Write projects and exported files under the user's `$HOME/workspace`. That directory and the tenant's `.dsh` data are stored in the main machine's VOS application storage. Temporary directories are for scratch work. Return workspace-relative paths for files the user should retain. OpenMotion projects live in `$HOME/workspace/OpenMotion`; keep exports there or in the active project.
