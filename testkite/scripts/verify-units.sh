#!/usr/bin/env bash
# Offline syntax gate for the systemd units in apps/runner/deploy/systemd.
#
# WHY THIS PARSES OUTPUT INSTEAD OF TRUSTING THE EXIT CODE (re-measured 2026-08-31, systemd 255):
#   $ systemd-analyze verify bad.service     # MemoryMax=nonsense + OOMPolicyy + Restrt
#   bad.service:7: Invalid memory limit 'nonsense', ignoring: Invalid argument
#   bad.service:8: Unknown key name 'OOMPolicyy' in section 'Service', ignoring.
#   bad.service:9: Unknown key name 'Restrt' in section 'Service', ignoring.
#   $ echo $?   ->  0                        # <-- a typo'd directive is SILENTLY IGNORED
# A misspelled MemoryMax would ship a fleet with no ceiling at all — the exact failure class this
# milestone exists to delete (docs/SYSTEM_DESIGN.md §1) — and an exit-code gate would stay green.
# So: any output that is not explicitly tolerated fails the gate. `test/deploy/verify-units.test.ts`
# feeds this script a deliberately broken unit and asserts it goes red; without that proof this
# script would be decoration.
#
# THE ONE TOLERATED MESSAGE is a missing ExecStart binary: podman/node are not installed on the
# CI runner (measured: `Command /usr/bin/podman is not executable: No such file or directory`,
# which also makes systemd-analyze exit 1 — the opposite direction of the same untrustworthy
# code). That is a runtime concern of the host image, not a defect of the unit file.
#
# What this gate CANNOT prove: that systemd applies any of it. This sandbox has no systemd
# (PID 1 is `process_api`) and CI never boots the fleet, so the directives are proven to PARSE
# here and proven to WORK only on a host pilot (`systemctl start ts-worker@1`, then read
# memory.max out of the unified hierarchy).
set -euo pipefail

# Default to this repo's deploy tree resolved from the SCRIPT's location, so the gate behaves the
# same from the repo root, from testkite/, and from `pnpm --filter @testkite/runner verify:units`
# (whose cwd is apps/runner). CI passes the path explicitly.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${1:-$script_dir/apps/runner/deploy/systemd}"

if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "systemd-analyze not found — install systemd-container or skip this gate on this machine" >&2
  exit 2
fi

if [ ! -d "$UNIT_DIR" ]; then
  echo "::error::unit directory not found: $UNIT_DIR" >&2
  exit 2
fi

status=0
checked=0
for unit in "$UNIT_DIR"/*; do
  [ -f "$unit" ] || continue
  checked=$((checked + 1))
  output="$(systemd-analyze verify "$unit" 2>&1 || true)"
  filtered="$(printf '%s\n' "$output" | grep -v 'is not executable: No such file or directory' | grep -v '^$' || true)"
  if [ -n "$filtered" ]; then
    echo "::error::systemd unit $unit has problems:" >&2
    printf '%s\n' "$filtered" >&2
    status=1
  else
    echo "ok: $unit"
  fi
done

# A gate that checks nothing passes everything: an empty or mistyped directory must be red, not
# silently green.
if [ "$checked" -eq 0 ]; then
  echo "::error::no unit files found in $UNIT_DIR" >&2
  exit 2
fi
exit "$status"
