# PGV Database Connector HTTP

Use PGV's **Integration Guide → API & protocol reference** for the deployed release's PGV and DBX request/response reference. DBX HTTP is the administrator workbench API. Its operation DTOs can change with PGV releases. PostgreSQL and Redis application traffic uses the native clients.

## Session and base URL

Use `https://<vos-host>:1180/app/com.ictrek.pgv` with the trusted VOS CA. Inside trusted `vos_default` the same gateway is `http://pgv-viewer:8081/app/com.ictrek.pgv`. Prefer HTTPS when sending credentials. `GET http://pgv-viewer:8081/healthz` returns `200 OK` for gateway liveness; it does not test database access. The upstream DBX listener at 8082 is container-loopback only.

Obtain a current VOS OAuth access token for the account named `admin` through the VOS OAuth authorization flow. The administrator owns the PGV workbench session and saved connector profiles. Treat queries using a managed PGV connection as administrator operations.

| Method and path below the base URL | Request and result |
| --- | --- |
| `POST /api/vos/login` | Same-origin `Origin`, JSON `{"access_token":"<token>"}`. A successful `200` sets the HttpOnly `pgv_vos_session` cookie and returns `{"assets":"<asset ticket>"}`. The ticket is for plugin assets. The gateway session has a 12-hour limit and VOS rechecks credentials on subsequent requests. |
| `GET /api/auth/check` | Cookie. `200 {"authenticated":true,"required":true,"setup_required":false}`. |
| `POST /api/auth/logout` | Cookie and same-origin `Origin`. `204` with an empty body; invalidates session and related tickets. |

Keep the cookie jar and login JSON in a private temporary directory. Reuse the cookie for DBX HTTP requests, and set `Origin` to the exact scheme and authority of the URL being called for writes. Use the same origin throughout the session. Provide JSON payloads with `Content-Type: application/json`. Standard VOS Bearer headers and native DBX password login do not create a PGV workbench session.

## Read-only request example

Set `VOS_ORIGIN` to the trusted HTTPS origin without a trailing slash. Supply `VOS_TOKEN` through protected configuration in the environment and configure curl to trust the VOS CA. This example lists connection names and IDs.

```sh
(
  set -eu
  umask 077
  session=$(mktemp -d)
  base="${VOS_ORIGIN:?set the VOS HTTPS origin}/app/com.ictrek.pgv"
  trap 'curl -fsS --max-time 15 -b "$session/cookies" -H "Origin: $VOS_ORIGIN" \
    -X POST "$base/api/auth/logout" -o /dev/null 2>/dev/null || true; rm -rf "$session"' EXIT
  jq -en 'env.VOS_TOKEN | select(type == "string" and length > 0) | {access_token: .}' > "$session/login.json"
  curl -fsS --max-time 15 -c "$session/cookies" -H "Origin: $VOS_ORIGIN" \
    -H 'Content-Type: application/json' --data-binary @"$session/login.json" \
    "$base/api/vos/login" -o /dev/null
  curl -fsS --max-time 15 -b "$session/cookies" "$base/api/auth/check" -o /dev/null
  curl -fsS --max-time 15 -b "$session/cookies" "$base/api/connection/list" > "$session/profiles.json"
  jq '[.[] | {id, name, db_type}]' "$session/profiles.json"
)
```

## Common operations

| Method and path | Payload and successful response |
| --- | --- |
| `GET /api/connection/list` | Array of saved profiles; use their IDs. Credential references are not plaintext passwords. |
| `POST /api/connection/test`, `/api/connection/test-info`, `/api/connection/connect` | JSON `{config: ConnectionConfig, clientAttempt?: integer}`. Test and connect return JSON strings; test-info returns `{message, database_info?}`. Connection fields such as `db_type` and `save_password` use snake_case. Connect before querying. |
| `POST /api/connection/save` | `{configs: ConnectionConfig[], removedIds?: string[]}` upserts by ID and removes only explicitly listed IDs; success is JSON `null`. |
| `POST /api/query/execute` | `{connectionId, database, sql, schema?, timeoutSecs?, maxRows?}` (identifier, database and SQL are strings; timeout and row cap are numbers). Returns `columns`, `rows`, `column_types`, `column_sortables`, `affected_rows`, `execution_time_ms` and optional metadata. Map rows by column position. |
| `POST /api/query/cancel` | `{executionId: string, cancel?: boolean}`; bind the execution ID on submit. Returns `{requested, terminal, databaseTerminal?}`. Check final execution and transaction state. |
| `GET /api/ai/configs`, `POST /api/ai/models` | Lists AI configs. Models takes `{config: AIConfig}`; the managed V-Scheduler entry returns `[{id, displayName}]` filtered by the current VOS identity. |

Use the deployed API reference for schema introspection, Redis and MongoDB workbench operations, imports, exports, transfers, SQL files, AI streaming and exact DTO fields. Some jobs use SSE and separate cancel or download routes. Wait for a terminal event, and inspect the artifact's response headers before reading it. HTTP success on stream start does not establish job success.

Read status and content type first. The gateway can return plain-text `401` for missing or expired sessions, `403` for non-admin tokens, Origin errors or disabled native authentication, `405` for an unsupported method, `502` for DBX unavailability and `503` for V-Scheduler unavailability. Native backend errors can carry structured `code`, `messageKey`, `operationOutcome` and `transactionOutcome` fields. Refresh the PGV session for 401, verify account and Origin for 403, and check the corresponding service for 502 or 503.
