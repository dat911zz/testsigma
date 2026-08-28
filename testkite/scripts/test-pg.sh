#!/usr/bin/env bash
# Spins up a disposable PostgreSQL cluster for concurrency tests, printing the connection URL.
#   eval "$(scripts/test-pg.sh start)" && pnpm test && scripts/test-pg.sh stop
# Requires a local Postgres binary (Ubuntu: apt-get install -y postgresql).
set -euo pipefail

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
PGDATA="${TESTKITE_PGDATA:-/var/lib/postgresql/tktest}"
PGPORT="${TESTKITE_PGPORT:-55432}"

if [ -z "$PGBIN" ]; then
  echo "PostgreSQL binary not found under /usr/lib/postgresql/*/bin" >&2
  echo "Install: apt-get update && apt-get install -y postgresql" >&2
  exit 1
fi

case "${1:-start}" in
  start)
    # Deliberate deviation from the plan's block: `start` MUST be IDEMPOTENT.
    # Running `start` a second time while the cluster is already up makes pg_ctl exit non-zero,
    # and `eval "$(...)"` swallows the URL (eval of an empty string still returns 0) ⇒
    # TESTKITE_TEST_PG_URL ends up empty ⇒ the whole concurrency layer silently SKIPs.
    # Exactly the kind of false-green this task exists to kill.
    if su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
      echo "export TESTKITE_TEST_PG_URL=postgres://postgres@127.0.0.1:$PGPORT/postgres"
      exit 0
    fi
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$(dirname "$PGDATA")"
      chown postgres:postgres "$(dirname "$PGDATA")"
      su postgres -c "PATH=$PGBIN:\$PATH initdb -D $PGDATA -U postgres --auth=trust -E UTF8" >/dev/null
    fi
    # fsync=off: this cluster is disposable — it doesn't retain data across runs.
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA \
      -o '-p $PGPORT -c fsync=off -c full_page_writes=off -c synchronous_commit=off' \
      -l $PGDATA/server.log start -w" >/dev/null
    echo "export TESTKITE_TEST_PG_URL=postgres://postgres@127.0.0.1:$PGPORT/postgres"
    ;;
  stop)
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA stop -m fast" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
