#!/usr/bin/env bash
# PostgreSQL custom-format backup of the Portifact database.
#
# Usage: ./scripts/backup.sh <destination_path>
#
# Writes to <destination_path>, which must not already exist (refuses to
# overwrite). No credentials are printed; PGPASSWORD is read from the
# environment and never echoed. Exits non-zero on any failure.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <destination_path>" >&2
  exit 2
fi

dest="$1"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi
if [[ -e "$dest" ]]; then
  echo "Destination already exists: $dest" >&2
  exit 2
fi

# Restrictive mode: create the destination file 0600 before writing so the
# backup is never world-readable, even momentarily.
umask 077
tmp="$(mktemp "${dest}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# pg_dump reads DATABASE_URL via the connection string; credentials are passed
# in-process and never appear on the command line or stdout.
if ! pg_dump --format=custom --no-password --file="$tmp" "$DATABASE_URL"; then
  echo "pg_dump failed" >&2
  exit 1
fi

mv "$tmp" "$dest"
echo "Backup written to $dest"
