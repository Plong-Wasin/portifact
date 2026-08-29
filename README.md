# Portifact

Self-hosted artifact storage and sharing service with a web UI, MCP API, PostgreSQL, and background cleanup worker.

## Requirements

- Docker Engine
- Docker Compose v2

## Quick start

```sh
cp .env.example .env
```

Set these values in `.env` before starting:

- `BETTER_AUTH_SECRET`: random value, at least 32 characters
- `SHARE_LINK_ENCRYPTION_KEY`: 32-byte base64 key
- `POSTGRES_PASSWORD`: database password
- `DATABASE_URL`: use the same database credentials, for example:
  `postgresql://portifact:<password>@postgres:5432/portifact`

Generate secrets:

```sh
openssl rand -base64 48
openssl rand -base64 32
```

Start all services:

```sh
docker compose up -d --build
```

Open `http://localhost:3000`. To use another host port, set `HOST_PORT` in `.env`, for example `HOST_PORT=8080`, then open `http://localhost:8080`. The app port inside the container remains fixed at `3000`.

The first migration runs automatically before the app and worker start. Check service health:

```sh
docker compose ps
docker compose logs -f app
```

## Create a user

Registration is disabled by default. Create the first account from the CLI:

```sh
docker compose run --rm app bun run user:create
```

Follow the prompts. Enable public registration only when needed:

```dotenv
REGISTRATION_ENABLED=true
```

When Microsoft login is configured, the first successful sign-in provisions the
user automatically. The password form, public registration, and CLI-created
password accounts are not part of the normal Microsoft login flow.

## Development

Install Bun dependencies locally:

```sh
bun install
bun run dev
```

Run migrations and tests:

```sh
bun run db:migrate
bun test
bunx tsc --noEmit
```

For local development without Docker, set `DATABASE_URL` to a reachable PostgreSQL instance.

## Services

| Service | Purpose |
| --- | --- |
| `postgres` | PostgreSQL database with a persistent Docker volume |
| `migrate` | Applies Drizzle migrations once per deployment |
| `app` | Web UI, authentication, artifact API, and MCP endpoint |
| `worker` | Processes delayed artifact purge jobs |

## Backup and restore

Create a PostgreSQL custom-format backup:

```sh
DATABASE_URL="postgresql://..." ./scripts/backup.sh ./backup.dump
```

Restore is destructive. Stop the app and worker first, then type the displayed database name when prompted:

```sh
docker compose stop app worker
DATABASE_URL="postgresql://..." ./scripts/restore.sh ./backup.dump
docker compose up -d
```

Never commit `.env`, database backups, private keys, or generated secrets.

## Configuration

See `.env.example` for all settings. Important limits include:

- `MAX_ARTIFACT_CONTENT_BYTES`: maximum UTF-8 source size per artifact version
- `MAX_STORAGE_BYTES_PER_USER`: per-user retained storage quota
- `SOFT_DELETE_RETENTION_DAYS`: delay before deleted artifacts are purged
- `ACCESS_TOKEN_TTL_SECONDS`: MCP access-token lifetime
- `IDEMPOTENCY_TTL_SECONDS`: idempotency replay window

### Microsoft Entra login

For a company deployment, register a Microsoft Entra web application with the
account type **Accounts in this organizational directory only**. Register this
exact redirect URI, derived from `APP_URL`:

```text
https://your-public-host.example.com/api/auth/callback/microsoft
```

Set these values through deployment secrets/configuration:

```dotenv
MICROSOFT_CLIENT_ID=<application-client-id>
MICROSOFT_CLIENT_SECRET=<application-client-secret>
MICROSOFT_TENANT_ID=<organization-tenant-guid>
```

To exclude guest identities as well as consumer identities, add the
optional `acct` claim to the application's ID token. Portifact accepts only
`acct=0` (a member of the configured tenant). Tokens from another tenant,
consumer accounts, guest identities, or tokens without the required member
claim are rejected. Keep the client secret out of source control and logs.

Portifact requests only the `openid`, `profile`, and `email` identity scopes;
it does not request Microsoft Graph Mail permissions or send email.

## MCP

The MCP endpoint is available at `/mcp`. OAuth discovery and protected-resource metadata are exposed under `/.well-known/`.

Use HTTPS and a trusted reverse proxy in production. Set `APP_URL` to the public HTTPS URL and configure `APP_HOST` to its hostname.
