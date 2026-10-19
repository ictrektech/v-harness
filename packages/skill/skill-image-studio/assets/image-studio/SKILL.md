---
name: image-studio
description: Generate, edit, or animate images with the local Image Studio service. Load to route image, video, and model-preparation requests.
---

# Image Studio task routing

Image Studio is a self-hosted generation service on the local network. It runs jobs asynchronously and stores every output under the calling account.

Call the `skill` tool for the matching workflow before running anything:

- Text-to-image, image-to-image, editing, or video generation: `image-studio-generate`.
- "Model not ready", listing capabilities, downloading weights, quantized variants, or low-VRAM choices: `image-studio-models`.

## Baseline flow

1. Check the model is ready (`image-studio-models` when it is not).
2. Submit the job and wait for it, then download the outputs into the task workspace.
3. Inspect downloaded images with the image-reading tool before describing them; never guess what was rendered.
4. Report the prompt, model, seed, and absolute output paths.

## Boundaries

- One generation may queue behind another; a video can take up to an hour. Do not retry while a job is running.
- If the service is unreachable, report that plainly and stop; do not start another client or install a different renderer.
- Do not print or pass the auth token. It belongs to the auth file consumed by the CLI.
