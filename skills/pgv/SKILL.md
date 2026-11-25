---
name: pgv
description: "Use for PGV on VOS: connect to its PostgreSQL/pgvector or shared Redis, check connectivity, inspect schemas or run bounded queries, configure a VOS app's data connection, or use the PGV Database Connector API. 当用户提到 PGV、VOS 内部数据库、向量检索、PGV 共享 Redis 或数据库连接器 API 时使用。"
---

# PGV on VOS

Install and start PGV (`com.ictrek.pgv`) on the same VOS device first. Its PostgreSQL, Redis and Database Connector containers share `vos_default` with v-harness. Use the connection that matches the requested task.

| Task | Address inside VOS | Credential |
| --- | --- | --- |
| Query PostgreSQL, use pgvector or integrate an app | `pgv:5432` (PostgreSQL wire protocol) | The approved database, role and its password |
| Inspect or integrate shared Redis | `pgv-redis:6379` (RESP) | The approved Redis ACL credentials or shared password and allocated DB/prefix |
| Use the DBX administrator workbench HTTP API | `http://pgv-viewer:8081/app/com.ictrek.pgv` in trusted `vos_default`; `https://<vos-host>:1180/app/com.ictrek.pgv` via VOS | PGV session cookie obtained using VOS OAuth for the account named `admin` |

## Workflow

1. Confirm the requested service, database or Redis namespace and authorized operation. For app integration, use a dedicated least-privilege PostgreSQL role and database. For Redis, keep operations within the assigned prefix and DB. A logical Redis DB and prefix organize names, while ACLs enforce permissions.
2. Read [native PostgreSQL and Redis](references/native.md) for commands, extension inspection, connection settings and errors. Read [Database Connector HTTP](references/connector.md) for authentication, payloads, errors and references for streaming jobs.
3. Use credentials already provided to the authorized workspace or service through protected configuration. If they are missing, give connection instructions and report what credential or grant is needed. Keep passwords, VOS tokens and cookies out of prompts, command arguments, logs, committed files and returned output. A v-harness session and a V-Scheduler key confer no PGV privileges.
4. For inspection, start with a connectivity test and read-only, time-bounded queries or prefix-scoped Redis scans with small output. For writes, verify the requested scope and effects, and check the transaction or job state before retrying after an ambiguous failure. Return the result or the specific connection, authentication or permission failure.
5. For DNS errors, check that PGV is running on the same VOS device and both apps use `vos_default`. If the tenant can resolve a PGV alias but times out after PGV was installed or recreated, restart the tenant runtime so v-harness resolves the service addresses again. Ask the deployment administrator to check `VH_NET_ALLOW_HOSTS` if it is overridden.
