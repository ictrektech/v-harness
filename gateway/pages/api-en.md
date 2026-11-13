# v-harness API v1

Use your VOS account to start a conversation, submit work and read the result from a script. API sessions use your v-harness workspace and the default model selected under **Settings → Models**. Configure a model available to your account in V-Scheduler first. A regular VOS account with access to v-harness can use these endpoints.

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

Open Settings → VOS operations. This browser API uses the same-origin base `/__vh/vos-ops`, optionally under `/app/com.ictrek.v-harness`. It requires the v-harness session cookie created from VOS login and checks `system_admin` against VOS on every request. Send `X-VH-Ops: 1` and, except for authorization, `X-VH-Ops-Grant`. POST bodies are JSON objects. Responses are JSON with caching disabled. The console API has no cross-origin or Agent Bearer entry.

| Method and path | Input and output |
|---|---|
| POST /authorize | Body `{}`. Returns opaque string `grant` and `expiresIn: 900` seconds. Replaces the previous grant for the same session. |
| POST /close | Body `{}`. Revokes the grant and its pending preview. Returns `closed: true`. |
| GET /inventory | No parameters. Returns arrays `apps`, `containers`, `publishedPorts`, `unusedImages` and `unreferencedTaggedImages`. Arrays can be empty. |
| GET /status | Required query `id` is the app ID, at most 128 characters, starting with a letter or number and optionally containing dots, underscores and hyphens thereafter. Returns `appId`, `version`, `state`, `lastError` and `workflow`. |
| GET /logs | Required query `id` is the full 64-character lowercase hexadecimal container ID. Returns `id` and UTF-8 `text` with timestamps and up to 150 lines, limited to 512 KiB before decoding. |
| POST /preview | Required strings `action` and `id`. Actions are `restart` (app ID), `remove-container` (full container ID) , `stop-container` (full container ID), and `remove-image` (`sha256:` followed by 64 lowercase hex characters). Returns opaque `confirmation`, `expiresIn: 60` seconds, `action`, `targetId` and the matching inventory record as `target`. A new preview replaces the previous one. |
| POST /execute | Required strings `confirmation` and `targetId`. After checking the preview, send its confirmation and the complete target ID. Returns `action`, `id` and `taskId` (the VOS restart task ID, or null for cleanup). Check application status for restart progress. Confirmation is single-use. Check status and preview again after a failed attempt. |
| GET /proposal | Query parameter `sessionId` is the conversation ID. Returns nullable `proposal` with `action`, `targetId`, `target` and `confirmation`. |
| POST /confirm-proposal | Query parameter `sessionId`. Body contains `confirmation`, boolean `approved`, and `targetId` when approving. Returns the /execute result or `cancelled: true`. |

App records have string fields `appId`, `installationId`, `version`, `state`, `lastError` (empty when there is no error). VOS application states are `not_installed`, `installing`, `installed`, `stopping`, `stopped`, `starting`, `upgrading`, `uninstalling`, `uninstalled`, `restarting` and `error`, shown as returned by VOS. Other apps in `installed` can be submitted for restart, subject to VOS checks. `workflow` is null or an object with string fields `taskId`, `status`, `failure` (empty without a failure) and nullable string `stage`. Workflow states are `Running`, `Completed`, `Failed`, `Cancelled`, `Terminated`, `TimedOut` and `ContinuedAsNew`.

Container records have string fields `id`, `name`, `image`, `imageId`, `state` and `status`; booleans `cleanup` and `stoppable`; `stack` with string fields `appId`, `version` and `project`; and a `ports` array. Container states come from Docker. Cleanup requires `exited` and rechecks app ownership and version. Port records have numeric `hostPort` and `containerPort`, string `protocol` (Docker values tcp, udp and sctp), and string `address`. The host-wide `publishedPorts` also include container name `container` and nullable string `appId`.

Untagged image records have string `id`, numeric `created` (Unix seconds) and `bytes` (bytes). Tagged records substitute string array `tags` for `created` and are informational. Container cleanup retains volumes. Image cleanup uses neither force nor parent pruning.

Failures return `{"error":"<code>"}`. For 400 `invalid-body`, `invalid-target` or `confirmation-mismatch`, check the JSON, action and complete ID. For 401 `sign-in-required`, sign in again. For 403 `forbidden`, check the role, same-origin request and active grant. For 404 `not-found`, refresh. For 409 `target-changed`, refresh and preview again. For 429 `too-many-grants`, wait for grants to expire. For 502 `vos-request-failed`, `docker-unavailable`, `response-too-large` or `upstream-unavailable`, inspect the VOS or Docker service. Restart acceptance precedes completion. Refresh app status before retrying a timed-out request.

The `vos_diagnostics` tool accepts `inventory`, `status`, `logs` and `propose`. The last three require string `id` in the formats above; `propose` also requires `action`. Results are diagnostic JSON text, limited to 49,152 characters. VOS system administrators can use it by choosing `vos-full-access`. Conversation confirmation requires no Settings grant header. The `sessionId` is a conversation ID in the current tenant, 1–128 letters, digits, underscores or hyphens. Each conversation can have one pending proposal for 120 seconds. A second proposal returns 409 `confirmation-pending`.

In DS Bot, open Settings → Models. The **V-Scheduler** section lets you select a default model from the existing catalog and refresh the list. **Custom model providers** lists only providers added in DS Bot. Use **Add a provider** to configure one. The Agent API model contract is unchanged.

If an old VOS app container holds a port or a runner lock, select **Full access (VOS operations)** and ask the Agent to inspect the app. For an eligible container, review **Stop old container**, enter its complete ID and confirm. Refresh inventory before requesting a restart of the current app or a separate cleanup of the stopped container. The stop preserves the container and its data. The `stoppable` flag applies to recognized running or restarting containers from a different version of an installed or stopped VOS app other than v-harness. The gateway rechecks the installed version and installation ID before stopping. A stale or ineligible target returns 409 `target-changed`.

For VOS operations, use the application ID from inventory for status or restart. A repair proposal awaits confirmation and reports `executed: false`. If a proposal already exists, HTTP 409 `confirmation-pending` includes its `action`, `id` and remaining `expiresIn` in seconds. Confirm or cancel in the conversation. An expired or consumed confirmation returns 409 `confirmation-unavailable`. A Docker ID sent to application status returns 400 `app-id-required`; use inventory for container state or logs for its output.

### Host management

A VOS system administrator opens a conversation, selects **Host management**, and confirms **Enable host management**. The Agent can then list host Docker containers, read their recent logs and propose starting, stopping, restarting or removing a container by full ID. Review each proposed target in the conversation before confirming. Removal requires a stopped container and preserves volumes. Select **Turn off host management** to end access early. The grant expires after 30 minutes and is checked against the administrator role and the VOS browser session on each call. See Settings → API documentation.

The browser uses `GET /__vh/vos-ops/host-mode?sessionId=<conversation-id>` to read `{available:true,enabled:boolean}`. Use `POST` on the same path with JSON `{enabled:true}` or `{enabled:false}` to turn access on or off. Use the current VOS browser session and the same-origin `X-VH-Ops: 1` header. The conversation ID follows the format above and must exist in that account when changing the mode. Sign-out, role revocation and gateway restart end access.

The in-session `vos_host_containers` tool accepts `operation` values `list`, `logs`, `start`, `stop`, `restart` and `remove`. Supply `id` as the full lowercase 64-digit hexadecimal container ID for all but `list`. Inventory returns the container record above with `stack` null for containers outside the main VOS stack. Logs use the same line and byte limits as VOS diagnostics. The write operations submit `host-start`, `host-stop`, `host-restart` and `host-remove` to the existing conversation confirmation flow. Start accepts `created` or `exited`, stop and restart accept `running` or `restarting`, and removal accepts `created`, `exited` or `dead`. Successful confirmation returns `action`, `id` and `taskId:null`. Invalid input is 400, a missing VOS login is 401, an unauthorized role or session is 403, a missing log target is 404, a stale or ineligible target is 409, the active-grant limit is 429 and Docker failures are 502.
