#!/usr/bin/env bash
# Dựng một cluster PostgreSQL dùng-một-lần cho test concurrency, in ra URL kết nối.
#   eval "$(scripts/test-pg.sh start)" && pnpm test && scripts/test-pg.sh stop
# Cần binary Postgres local (Ubuntu: apt-get install -y postgresql).
set -euo pipefail

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
PGDATA="${TESTKITE_PGDATA:-/var/lib/postgresql/tktest}"
PGPORT="${TESTKITE_PGPORT:-55432}"

if [ -z "$PGBIN" ]; then
  echo "Không tìm thấy binary PostgreSQL trong /usr/lib/postgresql/*/bin" >&2
  echo "Cài: apt-get update && apt-get install -y postgresql" >&2
  exit 1
fi

case "${1:-start}" in
  start)
    # Lệch có chủ đích so với block trong plan: `start` phải IDEMPOTENT.
    # Chạy `start` lần hai khi cluster đang sống thì pg_ctl thoát khác 0, `eval "$(...)"`
    # nuốt mất URL (eval của chuỗi rỗng vẫn trả 0) ⇒ TESTKITE_TEST_PG_URL rỗng ⇒ toàn bộ
    # tầng concurrency lặng lẽ SKIP. Đúng loại "xanh giả" mà task này sinh ra để diệt.
    if su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
      echo "export TESTKITE_TEST_PG_URL=postgres://postgres@127.0.0.1:$PGPORT/postgres"
      exit 0
    fi
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$(dirname "$PGDATA")"
      chown postgres:postgres "$(dirname "$PGDATA")"
      su postgres -c "PATH=$PGBIN:\$PATH initdb -D $PGDATA -U postgres --auth=trust -E UTF8" >/dev/null
    fi
    # fsync=off: cluster này là dùng-một-lần, không giữ dữ liệu qua lần chạy.
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA \
      -o '-p $PGPORT -c fsync=off -c full_page_writes=off -c synchronous_commit=off' \
      -l $PGDATA/server.log start -w" >/dev/null
    echo "export TESTKITE_TEST_PG_URL=postgres://postgres@127.0.0.1:$PGPORT/postgres"
    ;;
  stop)
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA stop -m fast" >/dev/null 2>&1 || true
    ;;
  *) echo "dùng: $0 start|stop" >&2; exit 2 ;;
esac
