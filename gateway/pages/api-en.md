# v-harness API v1

Use your VOS account to start a conversation, submit work and read the result from a script. API sessions use your v-harness workspace and the default model selected under **Settings → Models**. Choose a V-Scheduler model available to your account, or configure a personal provider through Settings → Models → Add model provider. Inference through a personal provider uses the credentials stored by that tenant. A regular VOS account with access to v-harness can use these endpoints.

The 0.2.3-alpha.2 VOS runtime uses its installed storage service even when a plugin carries an older copy. Existing workspace and session IDs remain valid across the upgrade. The request, response and authentication contract below is unchanged.

See the [application guide](https://twp99wyutbs.feishu.cn/docx/Iu0tdedumoMZ1LxMUSWckt7wn5v) for bundled plugins and DS Bot migration. Sessions, tasks, events and authentication use the endpoints below.

## Get a VOS access token

On the same VOS device, read the issuer metadata at `https://<vos-host>:1180/v1000/oauth2/.well-known/openid-configuration`. For an external integration, use an OAuth2 client registered by your VOS administrator with the integration's callback URL. For an integration embedded in v-harness, the installed public client is `com.ictrek.v-harness`.

1. Generate a random `state` and PKCE verifier of 43–128 URL-safe characters. Encode the verifier's SHA-256 digest as unpadded Base64URL to obtain the challenge.
2. Open the discovery document's `authorization_endpoint` in the browser, resolving a relative endpoint against the VOS origin. Pass `client_id`, the registered `redirect_uri`, `response_type=code`, `scope=openid profile email`, `state`, `code_challenge` and `code_challenge_method=S256`. Sign in to VOS and finish authorization.
3. Verify the callback `state` against the original value. Exchange its `code` at `token_endpoint` using a form-encoded POST with `grant_type=authorization_code`, `code`, `client_id`, the same `redirect_uri` and `code_verifier`. Authenticate the OAuth client as registered if it is confidential. Use the response's `access_token` and respect its `expires_in` in seconds.
4. When the access token expires, send a form-encoded request to the same endpoint with `grant_type=refresh_token`, `client_id` and `refresh_token` if issued. Keep any replacement refresh token. Otherwise repeat browser authorization.

Send `Authorization: Bearer <access_token>` with every v-harness API request. The gateway checks VOS UserInfo on every call and selects the tenant using the verified account's subject. Sessions and workspace IDs belong to that account. Use HTTPS and keep tokens out of URLs and logs.

## Run a task

The base URL is `https://<vos-host>:1180/app/com.ictrek.v-harness/__vh/api/v1`. For a separately exposed v-harness gateway, use its origin followed by `/__vh/api/v1`. All responses are JSON. POST bodies require `Content-Type: application/json` and are limited to 8 KiB including JSON encoding.

```bash
BASE='https://<vos-host>:1180/app/com.ictrek.v-harness/__vh/api/v1'
# Set VOS_ACCESS_TOKEN in your environment using the OAuth exchange above.
SESSION=$(curl -fsS "$BASE/sessions" -H "Authorization: Bearer $VOS_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq -er .sessionId)
REQUEST_ID=$(uuidgen)
curl -fsS "$BASE/sessions/$SESSION/prompts" -H "Authorization: Bearer $VOS_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg id "$REQUEST_ID" --arg text 'Summarize what this workspace is for.' '{requestId:$id,text:$text}')"
curl -fsS "$BASE/sessions/$SESSION/events" -H "Authorization: Bearer $VOS_ACCESS_TOKEN"
```

Poll events every few seconds. For one prompt at a time in a new session, wait for `prompt-recorded` with your request ID and then `turn-ended`. Read `assistant-text` events for that turn in sequence order. A task that requests interaction can be continued from the session in the v-harness UI. A client disconnect leaves accepted work running.

## Request and response fields

| Method and path | Input | Success |
| --- | --- | --- |
| `POST /sessions` | JSON object. Optional `workspaceId` selects an existing workspace owned by your account. Omit it with `{}` to use the deployment's default session directory. | `201 {"sessionId":"session-…"}`. Creates a new session on every success. |
| `POST /sessions/{sessionId}/prompts` | Required string `requestId` and nonblank string `text`. The prompt enters the session's turn queue. | `202 {"requestId":"…","accepted":true}`. Reuse the same request ID and text when retrying a prompt whose result is uncertain. |
| `GET /sessions/{sessionId}/events` | Optional integer `throughSeq` (inclusive log cut, at least −1, defaults to current log end) and `beforeSeq` (exclusive upper bound, at least 0, defaults to the end of the cut). Both are safe integers. | `200 {"cursor":-1,"beforeSeq":null,"events":[]}` for an empty journal. `cursor` identifies the inclusive cut. A non-null `beforeSeq` points to the next older page. |

IDs are case-sensitive strings of 1–128 ASCII letters, digits, underscores or hyphens. Omitted optional fields use the stated defaults. Unknown fields and query parameters, explicit nulls and empty identifiers are rejected. Each page covers up to 50 user or assistant messages plus their associated records. To read older results, reuse the returned `cursor` as `throughSeq` and send the returned `beforeSeq`. For live polling, omit both and deduplicate by `seq`. A filtered page can have an empty `events` array and still have an older page.

Events are chronological. Every event includes `seq` (zero-based journal sequence), `time` (Unix milliseconds), and `type`.

| Type | Additional fields |
| --- | --- |
| `prompt-recorded` | `requestId` string. The prompt is in the durable journal. |
| `assistant-text` | `turn` integer and `text` string. One committed assistant message's text. |
| `turn-ended` | `turn` integer and `outcome`. `completed` finished normally, `aborted` was cancelled, `blocked` stopped on a policy or interaction boundary, `error` failed, `max-tokens` hit the output limit, `interrupted` was closed after a process interruption, `forked` was closed at a fork boundary, and `other` is a plugin-defined outcome. |

The API returns committed text through polling. Tool events, attachments and partial tokens remain in the session UI.

## Errors and retries

Errors contain one string field, `error`, for example `{"error":"invalid-token"}`. A 405 response includes the permitted method in `Allow`.

| HTTP | Error | Action |
| --- | --- | --- |
| 400 | `invalid-request` | Check JSON fields, identifiers and pagination parameters. |
| 401 | `invalid-token` | Refresh or reauthorize the VOS account and retry. |
| 404 | `route-not-found`, `resource-not-found` | Check the path or use an ID owned by the authenticated account. |
| 405 | `method-not-allowed` | Use the method in `Allow`. |
| 409 | `session-busy` | Wait for the session to become available. Retry the prompt with the same request ID. |
| 413 | `body-too-large` | Send a smaller JSON body. |
| 415 | `json-required` | Use `Content-Type: application/json`. |
| 422 | `operation-rejected` | Open the session in v-harness and check the workspace and model settings. |
| 500 | `internal` | Check gateway health or contact the operator. |
| 502 | `identity-unavailable`, `controller-unavailable` | Check VOS UserInfo or the tenant's session controller, then retry with backoff. |
| 503 | `instance-unavailable` | Wait for the tenant to start and retry with backoff. |
| 504 | `controller-timeout` | The internal RPC exceeded 30 seconds. Check the session before retrying. |

VOS UserInfo has an 8-second request timeout. A cold tenant may take additional time to start before the controller call. Leave time for startup in your HTTP client. After a timed-out create, check the UI for the new session before creating another.

## VOS operations console

Open Settings → VOS operations. This browser API uses the same-origin base `/__vh/vos-ops`, optionally under `/app/com.ictrek.v-harness`. It requires the v-harness session cookie created from VOS login and checks `system_admin` against VOS on every request. Send `X-VH-Ops: 1` and, except for authorization and `GET /containers`, `X-VH-Ops-Grant`. POST bodies are JSON objects. Responses are JSON with caching disabled. The console API has no cross-origin or Agent Bearer entry.

| Method and path | Input and output |
|---|---|
| POST /authorize | Body `{}`. Returns opaque string `grant` and `expiresIn: 900` seconds. Replaces the previous grant for the same session. |
| POST /close | Body `{}`. Revokes the grant and its pending preview. Returns `closed: true`. |
| GET /inventory | No parameters. Returns arrays `apps`, `containers`, `publishedPorts`, `unusedImages` and `unreferencedTaggedImages`. Arrays can be empty. |
| GET /containers | Query parameter `sessionId` names a conversation that selected **Full access (VOS operations)** or enabled application container management. No grant header. Returns `containers` with `id`, `name`, `appId`, `version`, `state` and `status`, limited to VOS application stack containers; database, model and unrelated host containers are never returned. The composer's `@` container source uses this route. |
| GET /status | Required query `id` is the app ID, at most 128 characters, starting with a letter or number and optionally containing dots, underscores and hyphens thereafter. Returns `appId`, `version`, `state`, `lastError` and `workflow`. |
| GET /logs | Required query `id` is the full 64-character lowercase hexadecimal container ID. Optional `since` and `until` (RFC 3339 timestamps or relative spans such as `30m`), `after` (an RFC 3339 cursor: pass the previous response's `next` to receive only later records when polling; mutually exclusive with `since`), `pattern` (a case-insensitive regular expression of at most 200 characters) and `context` (0–50 records returned around each match). The time window and cursor are passed to Docker as `since`/`until` unix epoch seconds with one second of slack (this deployment's daemon rejects RFC 3339 there); `pattern` and `context` are filtered by the gateway per record. A record starts with a timestamp, and multi-line output such as stack traces folds into one record. Returns `id`, the reassembled `text`, plus `scanned`, `returned`, `first`, `last`, `next` (the cursor for the next poll; it stays put when no later record exists) and boolean `truncated`; beyond 300 records the earliest batch is returned with `truncated` set. With any filter or cursor the Docker-side scan window widens from 150 to 1000 lines. |
| GET /app-logs | Required query `appId` is the application ID; other parameters follow /logs. Returns one timeline merging every container in that application's compose stack, interleaved by timestamp, with each record prefixed by its container name. Returns `appId`, `containers` (container names), the merged `text`, plus `scanned`, `returned`, `first`, `last`, `next` and boolean `truncated` with the /logs semantics. An application outside the inventory or a stack without visible containers returns 404. |
| GET /diagnose | Required query `id` is the full container ID. Returns `id`, `name`, `image`, `stack`, `state` and `logs`. `state` carries `status`, `running`, `restarting`, `oomKilled`, `exitCode`, `error`, `startedAt`, `finishedAt`, `restartCount` and `health` (`status`, `failingStreak` and at most three `recent` entries with `start`, `end`, `exitCode`, `output`); `health` is null when the container has no health check. `logs` carries `scanned`, `first`, `last` and collapsed `errors` (each with `count`, `first`, `last`, `sample`, at most 40 entries). An invisible container returns 404; missing Docker metadata returns 409 `target-changed`. |
| POST /preview | Required strings `action` and `id`. Actions are `restart` (app ID), `remove-container` (full container ID) , `stop-container` (full container ID), and `remove-image` (`sha256:` followed by 64 lowercase hex characters). Returns opaque `confirmation`, `expiresIn: 60` seconds, `action`, `targetId` and the matching inventory record as `target`. A new preview replaces the previous one. |
| POST /execute | Required strings `confirmation` and `targetId`. After checking the preview, send its confirmation and the complete target ID. Returns `action`, `id` and `taskId` (the VOS restart task ID, or null for cleanup). Check application status for restart progress. Confirmation is single-use. Check status and preview again after a failed attempt. |
| GET /proposal | Query parameter `sessionId` is the conversation ID. Returns nullable `proposal` with `action`, `targetId`, `target` and `confirmation`. |
| POST /confirm-proposal | Query parameter `sessionId`. Body contains `confirmation`, boolean `approved`, and `targetId` when approving. Returns the /execute result or `cancelled: true`. |

App records have string fields `appId`, `installationId`, `version`, `state`, `lastError` (empty when there is no error). VOS application states are `not_installed`, `installing`, `installed`, `stopping`, `stopped`, `starting`, `upgrading`, `uninstalling`, `uninstalled`, `restarting` and `error`, shown as returned by VOS. Other apps in `installed` can be submitted for restart, subject to VOS checks. `workflow` is null or an object with string fields `taskId`, `status`, `failure` (empty without a failure) and nullable string `stage`. Workflow states are `Running`, `Completed`, `Failed`, `Cancelled`, `Terminated`, `TimedOut` and `ContinuedAsNew`.

Container records have string fields `id`, `name`, `image`, `imageId`, `state` and `status`; booleans `cleanup` and `stoppable`; `stack` with string fields `appId`, `version` and `project`; and a `ports` array. Container states come from Docker. Cleanup accepts `created` or `exited` and rechecks app ownership and version. Port records have numeric `hostPort` and `containerPort`, string `protocol` (Docker values tcp, udp and sctp), and string `address`. The host-wide `publishedPorts` also include container name `container` and nullable string `appId`.

Image records have string `id` and numeric `bytes` (bytes). `unusedImages` also has numeric `created` (Unix seconds) and contains images without tags, digests or container references. `unreferencedTaggedImages` also has a nonempty string array `tags` and a possibly empty string array `digests`. Use `remove-image` for either list. If the conversation lacks VOS operations access, the Agent directs a VOS system administrator to Full access (VOS operations). The shell only lists the current tenant’s Docker resources. As a system administrator, select **Full access (VOS operations)**, ask the Agent to clean up unused images, and review the tags and full IDs before confirming or skipping. The gateway rechecks references and tags, retains volumes and parents, and requests a non-forced deletion. Docker may refuse due to multiple tags, dependent images or a new container reference. Single-target execution returns 409 `image-delete-conflict`. In a batch, the corresponding result has `removed: false` and the same error code. Refresh inventory to inspect failed targets.

Failures return `{"error":"<code>"}`. For 400 `invalid-body`, `invalid-target`, `confirmation-mismatch`, `invalid-since`, `invalid-until`, `invalid-after`, `invalid-pattern` or `invalid-context`, check the JSON, action, complete ID and log query parameters. For 401 `sign-in-required`, sign in again. For 403 `forbidden`, check the role, same-origin request and active grant. For 404 `not-found`, refresh. For 409 `target-changed`, refresh and preview again. For 429 `too-many-grants`, wait for grants to expire. For 502 `vos-request-failed`, `docker-unavailable`, `response-too-large` or `upstream-unavailable`, inspect the VOS or Docker service. Restart acceptance precedes completion. Refresh app status before retrying a timed-out request.

The `vos_diagnostics` tool accepts `inventory`, `status`, `logs`, `app-logs`, `diagnose` and `propose`. All but `inventory` require string `id` in the formats above; `propose` also requires `action`. `diagnose` requires the full container ID and is preferred over `logs`: it returns state facts (exit code, OOM, restart count, health checks) and a collapsed error summary without raw logs. `app-logs` takes the application ID and returns the whole stack's interleaved, container-labeled timeline, so cross-service problems need no guesswork about which container to read. `logs` and `app-logs` additionally accept `since`, `until`, `after`, `pattern` and `context` with the semantics above. Results are diagnostic JSON text, limited to 49,152 characters. VOS system administrators can use it by choosing `vos-full-access`. Conversation confirmation requires no Settings grant header. The `sessionId` is a conversation ID in the current tenant, 1–128 letters, digits, underscores or hyphens. Each conversation can have one pending proposal for 120 seconds. A second proposal returns 409 `confirmation-pending`.

If an old VOS app container holds a port or a runner lock, select **Full access (VOS operations)** and ask the Agent to inspect the app. For an eligible container, review **Stop old container**, click Confirm this operation or Skip. Refresh inventory before requesting a restart of the current app or a separate cleanup of the stopped container. The stop preserves the container and its data. The `stoppable` flag applies to recognized running or restarting containers from a different version of an installed or stopped VOS app other than v-harness. The gateway rechecks the installed version and installation ID before stopping. A stale or ineligible target returns 409 `target-changed`.

For VOS operations, use the application ID from inventory for status or restart. A repair proposal awaits confirmation and reports `executed: false`. If a proposal already exists, HTTP 409 `confirmation-pending` includes its `action`, `id` and remaining `expiresIn` in seconds. Confirm or cancel in the conversation. An expired or consumed confirmation returns 409 `confirmation-unavailable`. A Docker ID sent to application status returns 400 `app-id-required`; use inventory for container state or logs for its output.

### Application containers

A VOS system administrator opens a conversation, selects **Application containers**, and confirms **Enable application container management**. The Agent then sees only containers of VOS application stacks, recognized by their VOS platform labels and `vos-app-*` project. Database, model and unrelated host containers are neither listed nor addressable: their IDs return 404 for logs and 409 `target-changed` for operations. Stack containers left behind by an uninstalled application stay listed for cleanup. The Agent can read recent logs and propose starting, stopping, restarting or removing a container by full ID. Review each proposed target in the conversation before confirming. Removal requires a stopped container and preserves volumes. Select **Turn off application container management** to end access early. The grant expires after 30 minutes and is checked against the administrator role and the VOS browser session on each call. See Settings → API documentation.

The browser uses `GET /__vh/vos-ops/host-mode?sessionId=<conversation-id>` to read `{available:true,enabled:boolean}`. Use `POST` on the same path with JSON `{enabled:true}` or `{enabled:false}` to turn access on or off. Use the current VOS browser session and the same-origin `X-VH-Ops: 1` header. The conversation ID follows the format above and must exist in that account when changing the mode. Sign-out, role revocation and gateway restart end access.

The in-session `vos_host_containers` tool accepts `operation` values `list`, `logs`, `diagnose`, `start`, `stop`, `restart` and `remove`. Supply `id` as the full lowercase 64-digit hexadecimal container ID for all but `list`. `diagnose` returns the same report as `/diagnose`, and `logs` additionally accepts `since`, `until`, `after`, `pattern` and `context` with the semantics above. Inventory returns the container record above for VOS application stack containers only; a log or diagnose request for any other container is 404 and an operation on it is 409. Logs use the same filter parameters and byte limits as VOS diagnostics. The write operations submit `host-start`, `host-stop`, `host-restart` and `host-remove` to the existing conversation confirmation flow. Start accepts `created` or `exited`, stop and restart accept `running` or `restarting`, and removal accepts `created`, `exited` or `dead`. Successful confirmation returns `action`, `id` and `taskId:null`. Invalid input is 400, a missing VOS login is 401, an unauthorized role or session is 403, a missing log target is 404, a stale or ineligible target is 409, the active-grant limit is 429 and Docker failures are 502.

The composer shows the VOS operations permission label in the current interface language.

Type `@` in the composer, open **VOS containers** and pick a container to reference it in the conversation. The reference carries the full container ID, so the Agent can propose an operation on that exact target. The entry appears only for a VOS system administrator whose conversation selected **Full access (VOS operations)**; otherwise the source is absent from the menu and makes no request. It lists VOS application stack containers only.

### Batch cleanup contract

For `remove-container`, `host-remove` or `remove-image`, the Agent can send `ids` with 1–20 distinct full IDs of the same target type in place of `id`. A proposal and a 409 `confirmation-pending` return `ids` in input order. `GET /proposal` returns `targetIds` and `targets` for the batch. Approval supplies the exact ordered `targetIds` in `POST /confirm-proposal`. A mismatch returns 400. Skip sends `approved:false` and the confirmation token. All targets are revalidated before deletion. A stale or ineligible target returns 409 before any deletion starts. The successful HTTP response returns `action` and ordered `results` with `id`, boolean `removed`, and `error` for failures. Volumes are preserved.

## Built-in skills from a session

Archify, Mnemon, PPT Design Skill and Vox Director are available to the Agent through the existing session prompt workflow. Generated files are written to the user's workspace. Mnemon stores facts under the user's persistent home directory, and Atlas Cloud video generation uses a user-provided credential. Submit a task with `POST /sessions/{sessionId}/prompts` and read its progress with `GET /sessions/{sessionId}/events`. The session API contract is unchanged.

For PGV, send `{"requestId":"<unique-id>","text":"Use /pgv to check which extensions are installed in my configured PostgreSQL database."}` to the same prompt endpoint. The Agent uses credentials already provisioned to the workspace and connects to the PGV service. v-harness exposes this through the existing prompt and event endpoints. From a VOS app on `vos_default`, connect directly to `pgv:5432` (PostgreSQL) or `pgv-redis:6379` (Redis). For Database Connector HTTP, use the base `http://pgv-viewer:8081/app/com.ictrek.pgv` on a trusted internal network or `https://<vos-host>:1180/app/com.ictrek.pgv` with the VOS CA. Call `POST /api/vos/login` with matching `Origin` and JSON `{"access_token":"<VOS admin token>"}` to receive the `pgv_vos_session` cookie. Use that cookie for `GET /api/auth/check` and `GET /api/connection/list`, and revoke it with `POST /api/auth/logout` and matching `Origin`. PGV credentials and the v-harness Bearer token serve separate APIs. Find the complete PGV operation fields, responses and errors in **PGV → Integration Guide → API & protocol reference**.

In **Plugins → Installed**, you can enable ModSearch to handle web searches and Billion Context to manage context for eligible model requests in your profile. Billion Context is enabled by default; ModSearch is disabled by default. API-created sessions use the same tenant’s settings and plugin selection as sessions created in the web UI. The VOS API v1 session, prompt and event contracts are unchanged. See the [VOS app guide](https://twp99wyutbs.feishu.cn/docx/Iu0tdedumoMZ1LxMUSWckt7wn5v) for setup.

## Compute nodes and model deployments

Open **Settings → VOS operations**, authorize diagnostics, and review Machines and Application backends. The links **Manage compute nodes in V-Scheduler** and **Deploy backends and prepare models in Image Studio** open the owning app with your VOS identity. Node registration, hardware scans, runtime validation, deployment and model preparation require the owning service's administrator role.

You can also ask the agent to manage these resources. For example, “List compute nodes, deploy an Image Studio backend on the node I select, prepare the model there, and report transfer and registration progress.” Provide any SSH credentials through a private JSON file. The agent uses your VOS identity through its tenant socket. A deployment receipt is followed by status checks. Model preparation reports source checks, file copy or shared storage, target verification and registration. Wait for **registered** before generating on that deployment. Interrupted preparations can be retried. Removing a remote model unregisters it and deletes that model's target files after the owning service checks active work.

## OpenMotion and persistent files

**OpenMotion 0.2.1** is preinstalled as `openmotion-dsh`, using the official local application's MCP tools and Skills. It is enabled by default. Ask for an OpenMotion project, an animation, or a video export. Its project data is stored in `$HOME/workspace/OpenMotion`. Media providers need their own configuration. Large renders require sufficient CPU, memory and disk space.

Workflow:

1. Select a workspace in v-harness. Under **Plugins → Installed → openmotion-dsh**, check that the switch is on. Restart the workspace if prompted.
2. Ask “Use OpenMotion to open the template library,” or describe the subject, duration, aspect ratio and style. Once the agent calls the plugin, open its returned preview/Studio link. Opening plugin details alone does not open the editor.
3. Review the visuals and timeline in the preview, and request edits in chat. Preview before approving export. Follow OpenMotion’s setup instructions to configure providers when generating image, video, music or narration assets.
4. After approval, ask the agent to export MP4 and save the project, assets and final video in the workspace. Projects use `$HOME/workspace/OpenMotion`. Download the returned files or back them up separately.

Example: “Use OpenMotion to make a 10-second, 16:9 product introduction with text and geometric shapes. Show a storyboard and a working preview first. Wait for approval before exporting MP4, and save the project and video in the workspace.”

Workspaces, designs, exported files, sessions and plugin settings under your tenant home are stored on the main VOS machine through `${VOS_APP_STORAGE_PATH}/data:/data`. Save deliverables under `$HOME/workspace`. The VOS app storage survives ordinary container replacement and app upgrades. Back up the app's storage before deleting its data or changing storage settings.

These integrations use tenant-private Unix sockets, with the current VOS token supplied by the gateway. Public VOS API v1 sessions, prompts and events retain their existing contract. The native compute API remains owned by [Image Studio](https://github.com/ictrektech/image-studio) and node management by [V-Scheduler](https://github.com/ictrektech/V-Scheduler/blob/main/docs/node-management.md).


## Voice input and enabled experimental features

OpenMotion, Billion Context, Voice input, Custom plugin indexes, Auto authorization review, and Change requests & worktrees are enabled by default. Find the experimental features under **Plugins → Installed → Experimental plugins**. ModSearch remains disabled by default.

Voice input selects **V-Voice · V-Scheduler**, reusing ASR models enabled in V-Voice with V-Scheduler user authorization and resource admission. The v-harness release image excludes the local SenseVoice plugin and its sherpa-onnx native dependencies; it does not download or load local recognition models. Install and start V-Voice and V-Scheduler, and prepare an ASR model in V-Voice. In Voice input settings, allow microphone access, select the input device and language, then record in the conversation composer. Check the transcription before sending the message. If unavailable, check the V-Voice model and scheduling resources and retry; refresh v-harness when sign-in expires. Upgrades migrate the former local SenseVoice selection to this service while retaining old model files.

Git, GitHub CLI (`gh`), and GitLab CLI (`glab`) are installed in the image for change requests and worktrees. Private repositories still require signing in inside the tenant. Enabling custom plugin indexes does not add index sources. Enabling Auto authorization review makes that access mode available without changing existing conversations' access modes.

Dictation uses the existing `speech/catalog`, `speech/configure`, `speech/prepare`, and `speech/transcribe` Remote protocols and does not automatically submit an Agent message. Public session API v1 paths, authentication, requests and events remain unchanged.

### VOS speech Remote interface

These same-origin browser routes use the base `/app/com.ictrek.v-harness/api/`, the tenant Cookie derived from VOS login, and Connection source checks. Discovery includes only V-Voice ASR models visible to the current user and never uses administrator service credentials. Send POST JSON such as `{"type":"client-request","rpcId":"<unique-id>","method":"speech/catalog","payload":{"args":{}}}`; the URL suffix and method use the same name below. Success is `{"type":"server-response","rpcId":"<same-id>","result":{"ok":true,"value":...}}`; failures have result.ok:false and result.error (code, message, details).

| Method suffix | payload.args | Successful value |
|---|---|---|
| `speech/catalog` | Empty object | providers (id, name, location, languages, preparation), selection (providerId, language), maxAudioBytes (4194304 bytes), maxDurationSeconds (120 seconds) |
| `speech/configure` | patch with optional providerId and language; omitted fields keep their values | No value; saves this user's selection |
| `speech/prepare` | Required providerId; optional options; VOS needs no downloadSource | No value; checks service availability without downloading models |
| `speech/cancelPreparation` | Required providerId | No value; cancels and awaits the current readiness check |
| `speech/transcribe` | Required request.audioBase64; optional request.providerId and request.language | text (string, possibly empty), audioSeconds and inferenceSeconds (seconds) |

The providerId is v-scheduler-voice. Protocol location is cloud, meaning an out-of-process service; this deployment actually uses V-Voice inside VOS. Language defaults to auto; accepted values are auto, zh, en, ja, ko, yue. preparation.phase is checking, ready, failed, or cancelled. checking includes startedAt (Unix milliseconds), failed includes message, and the other states omit those fields. Audio must be canonical base64 of complete 16 kHz mono 16-bit PCM WAV, within the catalog byte/time limits and V-Voice admission limits. Transcription waits at most 120 seconds. Cancellation aborts the request; V-Scheduler still confirms resource release.

Excess encoded length returns speech/invalid-audio. WAV validation, unknown provider/language, missing ASR, recognition and admission failures return speech/transcription-failed with variable diagnostic details.reason. Missing VOS login returns HTTP 401; an untrusted source returns 403. Service failures use the Remote result, so also check result.ok. Check V-Voice and V-Scheduler before explicitly retrying an unavailable or busy service. There is no silent fallback to a local model.
