---
description: "Bundled Image Studio skills for local text-to-image, editing, video generation, and weight preparation, driven through a zero-dependency CLI."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-image-studio

English | [中文](README.zh.md)

## Summary

The catalog lists an Image Studio router plus generation and model-preparation skills. Generation and model work run through a zero-dependency Node CLI that submits jobs, polls them, downloads outputs, and manages weights over the Image Studio HTTP API. Credentials stay in an auth file consumed by the CLI, so the bearer token never enters the model context.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider beside the skill registry and `dsh-tool-skill`. The base bundle declares the row but leaves it disabled until a deployment names an endpoint or an auth file, so profiles without the service keep an unchanged skill catalog.

```yaml
- name: '@deepseek-ai/dsh-skill-image-studio'
  disabled: false
  config:
    baseUrl: http://image-studio-backend:5000
    authFile: /home/user/.config/dsh/image-studio.json
```

Enabling happens either through `IMAGE_STUDIO_BASE_URL` or `IMAGE_STUDIO_AUTH_FILE`, or by a profile row that sets `disabled: false` with an explicit `baseUrl`.

| Field | Default | Meaning |
|---|---|---|
| `assetRoot` | Packaged `assets/` | Absolute directory containing the three skill folders and `scripts/`. |
| `node` | Host Node.js | Standalone Node executable for the CLI; packaged carriers supply it explicitly. |
| `cli` | `assets/scripts/image-studio.mjs` | Absolute CLI entry. |
| `baseUrl` | `IMAGE_STUDIO_BASE_URL` or the in-network backend | Backend origin or VOS gateway prefix. |
| `authFile` | `IMAGE_STUDIO_AUTH_FILE` or `$XDG_CONFIG_HOME/dsh/image-studio.json` | JSON file holding `{ "baseUrl"?, "token"? }`. |
| `requestTimeoutMs` | `30000` | Per-request HTTP timeout. |

The auth file carries the VOS access token and is read by the CLI at request time:

```json
{ "baseUrl": "https://vos.example/api/com.ictrek.image-studio", "token": "<vos access token>" }
```

Without a token the service attributes work to an anonymous bucket, which still generates images but cannot use account-scoped features. Invalid skill assets, relative paths, non-http endpoints, and missing executables reject registration.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider reads descriptions at registration and bodies on demand, then appends a runtime block with absolute Node and CLI paths plus the resolved endpoint and auth-file path. Registry precedence, scope, and invocation permissions apply to every skill. Disposal unregisters all candidates.

The CLI is a zero-dependency ESM script. It resolves the endpoint from `--base-url`, `IMAGE_STUDIO_BASE_URL`, the auth file, then the in-network default; it resolves the token from `--token-file`, the auth file, then `IMAGE_STUDIO_AUTH`. Requests use the host Node `fetch`; downloads stream to the workspace so binary outputs never pass through text tools.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Resource registration, configuration validation, runtime injection. |
| [`assets/scripts/image-studio.mjs`](assets/scripts/image-studio.mjs) | Generation, polling, downloads, model preparation, reference uploads. |
| [`assets/`](assets/) | Router and two subskills. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Skill registry](../skill/README.md) — discovery and precedence.
- [Skill tool](../tool-skill/README.md) — model catalogs and loaded bodies.
- [Image Studio API reference](https://github.com/ictrektech/image-studio) — endpoints, parameters, and model registry.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the three Image Studio summaries and returns routing or selected subskill instructions from `skill(name)`.

#### KV Cache effect

Skill results append to history without changing tool declarations, and loaded instructions remain after an operation finishes. Character estimates use `ceil(characters / 4)`: the router body stays under 200 tokens and each subskill stays under 700. The runtime block repeats the Node, CLI, endpoint, and auth-file paths in every loaded skill; shell declarations, the generic catalog, and downloaded image or video attachments are separate costs, and these estimates are not server usage.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The AI album (Immich) upload flow is not part of this package yet.
- Generation waits in a per-service queue; long video jobs can run for about an hour.
- The CLI requires network access from the shell sandbox to the configured endpoint.
- Model downloads move 4–70 GB per family and are managed through the same service, not by this package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
