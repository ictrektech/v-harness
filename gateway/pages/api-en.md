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
