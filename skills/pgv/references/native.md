# PGV PostgreSQL and Redis

## PostgreSQL 17

Connect from `vos_default` using `pgv:5432`. Compatible aliases are `ictrek-pgv` and `shared-pgv`. For a client outside the VOS network use the VOS host and the configured `ICTREK_PGV_PORT` (default `25432`), subject to the deployment's network and TLS policy. PostgreSQL uses its native wire protocol and SQLSTATE errors. A connection URI has the form `postgresql://<role>:<encoded-password>@pgv:5432/<database>`. Put passwords in a protected client configuration such as a mode-0600 `PGPASSFILE`.

Use the built-in `psql` with `PGUSER` and `PGDATABASE` set to approved values and `PGPASSFILE` pointing at a provisioned file:

```sh
PGCONNECT_TIMEOUT=5 PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000' \
  psql -X -w -v ON_ERROR_STOP=1 -h pgv -p 5432 \
  -c 'SELECT current_database();' \
  -c 'SELECT extname, extversion FROM pg_extension ORDER BY extname;'
```

Use `information_schema` or the PostgreSQL catalogs to inspect accessible objects. Parameterize application queries and limit result size. For vector search, check that `vector` is installed in the target database, then match the embedding dimension and index operator class to the stored vectors and distance metric. With administrator approval, install extensions in the target database and grant only the needed schema/table permissions. Check **PGV → Integration Guide** for extension availability, provisioning, migration and recovery. Managed roles follow PGV installation settings, so coordinate password changes there with the app configuration.

SQLSTATE `28P01` indicates a password failure, `3D000` an unknown database, `42501` insufficient privileges, and `57014` a canceled query (including statement timeout). Check the approved role, case-sensitive database name and provisioning status. Establish transaction outcome before retrying a write after a broken connection.

## Shared Redis

Use `pgv-redis:6379` (also `ictrek-pgv-redis`) on `vos_default`. PGV publishes no Redis port on the VOS host. Redis is standalone, with logical DBs `0`–`15` and DB `0` as the client default. The deployment uses the injected `VOS_REDIS_PASSWORD` for the default user. Use only credentials the operator provisioned for this work. Keep a distinct application prefix even when allocated a separate DB. Treat the shared credential as service-wide access.

With `REDISCLI_AUTH` already supplied through protected configuration:

```sh
timeout 5s redis-cli -h pgv-redis -p 6379 PING
timeout 5s redis-cli -h pgv-redis -p 6379 -n "${APP_REDIS_DB:?set the allocated DB}" \
  SCAN 0 MATCH "${APP_REDIS_PREFIX:?set the allocated prefix}*" COUNT 50
```

Expect `PONG` and a cursor plus matching keys. `COUNT` is a hint. Advance the returned cursor until it becomes `0` or the requested sampling limit is met. With a named ACL user add `--user "$APP_REDIS_USER"`. `NOAUTH` and `WRONGPASS` indicate missing or rejected authentication. `NOPERM` indicates an ACL restriction. Avoid `KEYS *`, broad deletes and flush operations on the shared service.
