#!/usr/bin/env bash
# Restore a PostgreSQL custom-format backup into the Portifact database.
#
# Usage: ./scripts/restore.sh <backup_file>
#
# DESTRUCTIVE: restore overwrites the target database entirely. Before running,
# stop the app and worker so no connections hold locks or write during restore:
#
#   docker compose stop app worker
#
# Prerequisites:
#   - DATABASE_URL points at the target database (shown before confirmation).
#   - Exactly one backup file is given; globs that resolve to multiple files
#     are rejected.
#   - You must type the displayed database name to confirm.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <backup_file>" >&2
  exit 2
fi

file="$1"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

# Reject unresolved globs: if the shell expanded more than one match, or the
# argument contains an unexpanded glob character, refuse.
if [[ ! -f "$file" ]]; then
  echo "Backup file not found: $file" >&2
  exit 2
fi

# Extract the database name from the connection string for display+confirmation.
# Hides everything except the dbname so credentials are not printed.
db_name="$(printf '%s' "$DATABASE_URL" | sed -nE 's#.*/([^/?]+)(\?.*)?$#\1#p')"
if [[ -z "$db_name" ]]; then
  echo "Could not determine target database name from DATABASE_URL" >&2
  exit 2
fi

echo "DESTRUCTIVE OPERATION: this overwrites the target database."
echo "Target database: $db_name"
echo "Backup file:     $file"
echo "Ensure app and worker are stopped (docker compose stop app worker)."
echo
printf "Type the database name '%s' to confirm: " "$db_name"
read -r confirmation

if [[ "$confirmation" != "$db_name" ]]; then
  echo "Confirmation did not match target database name. Aborting." >&2
  exit 1
fi

# Drop+recreate then load so existing tables do not conflict with the restore.
# pg_restore reads DATABASE_URL; credentials never appear on the command line.
if ! psql --no-password "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA public CASCADE;" \
  -c "CREATE SCHEMA public;" \
  -c "GRANT ALL ON SCHEMA public TO postgres;" \
  -c "GRANT ALL ON SCHEMA public TO public;"; then
  echo "Schema reset failed" >&2
  exit 1
fi

if ! pg_restore --no-password --dbname="$DATABASE_URL" --no-owner --role=postgres --exit-on-error "$file"; then
  echo "pg_restore failed" >&2
  exit 1
fi

echo "Restore complete into database '$db_name'."
echo "Re-run migrations and restart services: docker compose up -d"
