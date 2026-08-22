#!/bin/sh
set -eu

: "${APP_HOST:?APP_HOST is required}"
: "${MAX_ARTIFACT_CONTENT_BYTES:?MAX_ARTIFACT_CONTENT_BYTES is required}"
case "$MAX_ARTIFACT_CONTENT_BYTES" in
  *[!0-9]*|'') echo "MAX_ARTIFACT_CONTENT_BYTES must be a positive integer" >&2; exit 1 ;;
esac
case "$MAX_ARTIFACT_CONTENT_BYTES" in
  0) echo "MAX_ARTIFACT_CONTENT_BYTES must be greater than zero" >&2; exit 1 ;;
esac

# APP_HOST must be a single DNS name or bracketed IPv6 / dotted IPv4. Reject any
# control character, whitespace, or nginx metacharacter that could inject config.
case "$APP_HOST" in
  *[!A-Za-z0-9.\-:\[\]]*)
    echo "APP_HOST contains invalid characters" >&2; exit 1 ;;
esac
if printf '%s' "$APP_HOST" | grep -Eq '[[:cntrl:]]|[\n\r]'; then
  echo "APP_HOST must not contain control characters" >&2; exit 1
fi
# IPv6 must be bracketed, bare colon only allowed inside brackets.
case "$APP_HOST" in
  *:*)
    case "$APP_HOST" in
      \[*\]) : ;;
      *) echo "IPv6 APP_HOST must be bracketed, e.g. [::1]" >&2; exit 1 ;;
    esac ;;
esac

host=$(printf '%s' "$APP_HOST" | sed 's/[\\/&]/\\&/g')
size=$(printf '%s' "$MAX_ARTIFACT_CONTENT_BYTES" | sed 's/[\\/&]/\\&/g')
sed -e "s/__APP_HOST__/$host/g" -e "s/__MAX_ARTIFACT_CONTENT_BYTES__/$size/g" \
  /etc/nginx/portifact.conf.template > /etc/nginx/conf.d/default.conf
