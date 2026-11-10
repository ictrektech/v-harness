# v-harness VOS API

## Summary

Manage your files, services and agent workspace through a verified VOS session. V-Scheduler authorizes model calls as that user. This reference covers the VOS gateway; native DSH RPC/SDK fields remain with their generated references.

## Table of contents

- [Addresses](#addresses) · [Identity and keys](#identity) · [Sessions](#sessions) · [Files](#files) · [Services](#services) · [Models](#models) · [Native RPC](#rpc) · [Errors and cancellation](#errors)

<h2 id="addresses">Addresses</h2>

Container alias: `v-harness:8080`; no separate host business port is published. VOS page: `/app/com.ictrek.v-harness/`. Gateway controls use `/__vh/*` on that VOS origin. Append those paths directly to the container address; they are not uniformly under `/api/v1`. The sidebar API guide displays this reference.

<h2 id="identity">Identity and keys</h2>

A VOS token verifies/renews identity. The application vh_session defaults to a 12-hour sliding expiry and is bound to User-Agent. Cookies and x-vh-session are private session credentials, not log data. Each subject owns a private OS user, workspace and DSH instance.

This app exposes no personal access-Key creation/update API. V-Scheduler personal Keys, model Keys and upstream-provider credentials do not grant gateway management access or another user's files. Per-user Scheduler/MCPHub capabilities are minted by the gateway, keep upstream VOS tokens out of the page and are not general management Keys.

<h2 id="sessions">Session API</h2>

GET `/__vh/session` returns200 even when signed out: `{authenticated:false,clientId,scope,csrf}`, plus a CSRF cookie. Signed-in responses include identity and tokenReady. POST `/__vh/session` (alias `/__vh/auth`) accepts JSON `{access_token,refresh_token?,expires_in?}` with the cookie from that GET and x-vh-csrf. Success200 returns `{authenticated:true,session,user:{username,namespace}}` and sets a session. Keep User-Agent stable. Identity failure401, unreachable VOS502 and invalid CSRF403 are distinct; successful sign-in does not prove instance startup.

GET `/__vh/whoami` returns subject/account/username/locale. POST `/__vh/logout` revokes the session, stops that user's instance, returns `{authenticated:false}` and clears the cookie. GET `/__vh/boot` returns `{boot,error?}`. POST `/__vh/restart` returns202 `{ok:true}` before asynchronous drain/restart; poll state rather than treating202 as recovery. GET `/__vh/enter?to=/PATH` permits limited entry for an already-known session after renewal fails; only same-origin redirect paths are allowed, and upstream credentials are not restored.

<h2 id="files">File API</h2>

GET `/__vh/files?dir=RELATIVE_DIR`:200 `{path,entries:[{name,type,size?,mtime}]}` inside the current workspace. GET `/__vh/files/raw?path=RELATIVE_FILE` returns an attachment, not JSON; missing path400, non-file400 and unavailable/missing file404. POST `/__vh/files/upload?dir=RELATIVE_DIR&name=FILENAME` takes raw bytes, not multipart; the native file-helper JSON is returned (with a `{ok:true}` fallback if parsing fails) or400 for invalid paths/names. URL-encode query values. Cross-user traversal is prohibited; container absolute paths are not workspace-relative paths.

<h2 id="services">Service and application APIs</h2>

GET `/__vh/services` lists the user's registered services. POST `/__vh/services/:port/restart` and `/stop` act only on owned services; the body does not select arbitrary processes. Errors return `{error,message}`. `/__vh/svc/:port/*` proxies only the user's registered services or owned-container published ports, including native HTTP/WebSocket; it is not an unrestricted network proxy. Internal service registration/heartbeats are separate from Scheduler inference registration.

GET `/__vh/mcphub/services` returns services/routing. GET `/__vh/mcphub/tools` previews tools. GET/PUT `/__vh/mcphub/selection` uses `{names:string[]|null}` and returns selected/restartRequired; selection applies at the next launch. POST `/__vh/mcphub/servers/:name/toggle|reload` permits only those actions and preserves MCPHub user authorization. `/__vh/mcphub/agent/*` is a process-capability proxy, not an endpoint accepting an arbitrary model Key.

GET `/__vh/office/list`:200 `{ok,total,files}`. GET `/__vh/office/session?name=FILE&edit=1&lang=en&v=0` returns an editor session; `/open` redirects302. Name must be nonempty and contain no path separators, edit=0 requests read-only, and a changed v can force a new editor session. `/__vh/weknora/*` and internal Album/Image Studio/PhotoCraft capabilities retain their owning protocols and permissions; file contents are not universally converted to JSON.

<h2 id="models">Models and V-Scheduler</h2>

The gateway discovers visible models from Scheduler `/api/v1/models` using the current VOS identity. It prefers qualified IDs and selects OpenAI, Responses, Anthropic or text-completion conversion from endpoints/capabilities; vision declares image input. Scheduler visibility and admission remain authoritative; a listed model does not bypass budgets.

`/__vh/scheduler/v1/models` and the corresponding chat/completions, responses and messages routes use an internal process capability and allow discovery/inference only. They cannot change Scheduler models, visibility, admission or Keys. External agents obtain a user-owned Key from V-Scheduler and call Scheduler directly; do not extract internal Harness capabilities.

<h2 id="rpc">Native DSH RPC / SDK</h2>

A user's DSH `/api` exposes generated Remote methods and exact routes, not `/v1/chat/completions`. Unary calls use HTTP POST; streams use `/api/remote.mux` WebSocket. Generated SDK/service definitions own argument/result types; arbitrary internal methods are not universally callable. The gateway preserves user isolation and replaces instance cookies; an external model Key does not grant instance-owner identity. Use the native SDK for subscriptions, tools and session streams; one HTTP success is not completion of an agent run.

- [Native transport and identity](../../packages/client/connection/README.md) · [Remote arguments/results/streams](../../packages/api/gateway/README.md) · [Generated API reference](../../docs/api-gateway.md) · [VOS gateway handlers](../../gateway/server.mjs)

<h2 id="errors">Errors, renewal and cancellation</h2>

Public GET `/__vh/health` returns only `{ok:true}`, without starting models or instances. JSON errors usually include error and optional message:400 input,401 session/identity,403 origin/permission,404 route/owned resource,405 method,409 runtime conflict and502 unreachable upstream/service. Do not blindly replay uploads, service restarts or session mutations. Expired sessions repeat the GET/POST handshake; changing User-Agent also invalidates them.

Stopping an agent, closing a stream, stopping a user service, restarting an instance and releasing model resources are distinct actions. Stream disconnection cancels its request but does not prove remote model unload; Scheduler releases resources from completion/stop evidence. Logout stops that user's instance, while restart interrupts/relaunches it; account for active user tasks.

## Dev Note

This reference changes no authentication, instance API or model routing.
