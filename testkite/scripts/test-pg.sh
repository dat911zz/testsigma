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

# Set the moment `start` has a cluster it can hand to the caller. Until then, whatever this
# invocation has already brought up belongs to nobody (see `cleanup`).
HANDOFF=0

# A start that is interrupted between `pg_ctl` and the `echo` is the worst of both worlds:
# measured 02-09-2026 on the version without this trap, SIGINT 50ms into a start exits 0 —
# silently, because `eval "$(...)"` of an empty string also returns 0 — and leaves a postmaster
# holding the port with nobody left holding its URL, so nobody ever runs `stop` on it. It sits
# there until the box reboots and makes the next start fail on a busy port.
# A COMPLETED start must of course leave the cluster running — that is the entire command — so
# cleanup is a no-op once HANDOFF is 1. It deletes nothing: initdb removes its own half-built
# $PGDATA when it fails (measured the same day), and a directory that outlives a failed start is
# a reusable cluster the next start picks straight back up. (SIGKILL is beyond reach, as always.)
cleanup() {
  trap - EXIT INT TERM
  if [ "$HANDOFF" -eq 1 ]; then
    return 0
  fi
  su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true
}

case "${1:-start}" in
  start)
    # INT/TERM exit non-zero ON PURPOSE: `eval "$(scripts/test-pg.sh start)"` of an empty string
    # returns 0, so a silent 0 here is the false-green the header above is about.
    trap 'cleanup; exit 130' INT
    trap 'cleanup; exit 143' TERM
    trap cleanup EXIT
    # Deliberate deviation from the plan's block: `start` MUST be IDEMPOTENT.
    # Running `start` a second time while the cluster is already up makes pg_ctl exit non-zero,
    # and `eval "$(...)"` swallows the URL (eval of an empty string still returns 0) ⇒
    # TESTKITE_TEST_PG_URL ends up empty ⇒ the whole concurrency layer silently SKIPs.
    # Exactly the kind of false-green this task exists to kill.
    if su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
      HANDOFF=1
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
    HANDOFF=1
    echo "export TESTKITE_TEST_PG_URL=postgres://postgres@127.0.0.1:$PGPORT/postgres"
    ;;
  stop)
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA stop -m fast" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
