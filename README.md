# NiviChat Backend

Server platform for NiviChat: a Fastify REST API (`/api/...`) + a standalone Node
WebSocket server (`src/ws-server.js`, port 8080), sharing one PostgreSQL database
through Prisma.

This backend is built to match the existing mobile client contract exactly (response
envelope, auth scheme, resource naming) — see `src/lib/response.ts` and `src/lib/auth.ts`.

## Stack

- Node.js 18 LTS+
- PostgreSQL 15/16
- Prisma (schema-first; `db push` in dev, not `migrate`)
- Fastify REST API, compiled with `tsc` to `dist/`
- Custom `ws` WebSocket server, separate process, port 8080
- Docker Compose (db + migrate + api + ws)

## Local development

```bash
cp .env.example .env   # fill in real secrets
npm install
npm run prisma:generate
npm run prisma:push
npm run prisma:seed
npm run dev              # Fastify API on :3000 (tsx watch, restarts on change)
npm run ws                # WebSocket server on :8080 (separate terminal)
```

Production-equivalent local run (what the Docker image actually executes):

```bash
npm run build             # tsc -> dist/
npm run start              # node dist/server.js
```

## Docker

```bash
docker compose build
docker compose up -d
docker compose logs -f api ws
docker compose down      # keeps the pgdata + uploads volumes
```

## API reference

All routes are mounted under `/api`, require `Authorization: Bearer <accessToken>`
unless noted, and return the envelope in `src/lib/response.ts`
(`{ status, message, data, app_version }` / `{ status:false, message, error, trace_id }`).
List endpoints are cursor-paginated (`?cursor=&limit=`). `trace_id` is the Fastify
request id (`request.id`) — pass `x-trace-id` on a request to control it yourself.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | ❌ | Create account |
| POST | `/api/auth/login` | ❌ | `{ accessToken, refreshToken, user }` |
| POST | `/api/auth/refresh-token` | refresh token | Rotate refresh token, mint new access token |
| POST | `/api/auth/logout` | ✅ | Revoke a refresh token |
| GET/PATCH | `/api/users/me` | ✅ | Current profile |
| GET | `/api/users?query=` | ✅ | Search users |
| GET | `/api/users/:id` | ✅ | Public profile lookup |
| GET/POST | `/api/chats` | ✅ | List chats / create-or-get a direct chat |
| GET/PATCH/DELETE | `/api/chats/:id` | ✅ | Detail + paginated messages / pin-mute-archive / leave |
| POST | `/api/messages` | ✅ | Send (also broadcasts `message:new` over WS) |
| GET/PATCH/DELETE | `/api/messages/:id` | ✅ | Detail / edit-delete-receipt-status / soft-delete |
| POST | `/api/groups` | ✅ | Create group |
| GET/PATCH/DELETE | `/api/groups/:id` | ✅ | Detail / update (admin) / disband (admin) |
| POST/DELETE | `/api/groups/:id/members` | ✅ | Add (admin) / remove (admin, or self-leave) |
| POST | `/api/attachments` | ✅ | Multipart upload, returns `{ url, type, fileName, fileSize }` |
| GET/POST | `/api/calls` | ✅ | History / log a call |

## WebSocket events (`ws-server.js`, port 8080)

First message after connecting must be `{ event: "auth", data: { token } }` within 5s.

| Client → Server | Server → Client |
|---|---|
| `auth` | `auth` (ack) |
| `message:send` | `message:new` |
| `typing:start` / `typing:stop` | `typing:update` |
| `message:read` | `message:status` (`DELIVERED` on real-time fan-out, `SEEN` on read), `presence:update` |
| `presence:ping` | `message:update` (edit/delete, extends the documented set) |
| `call:signal` | `call:incoming` / `call:signal`, `error` |

## Project structure

```
prisma/                   # schema.prisma, seed.ts — unchanged by the Fastify rewrite
src/server.ts               # Fastify bootstrap: plugins, route registration, graceful shutdown
src/plugins/                 # auth.ts (fastify.authenticate decorator), error-handler.ts (envelope mapping)
src/routes/                   # one Fastify plugin per resource: auth, users, chats, messages, groups, attachments, calls
src/lib/                       # prisma client, jwt/auth, response envelope, validation, serializers
src/ws-server.js                # standalone WebSocket process (plain Node, unaffected by the framework swap)
```

## Commit conventions

Commits are linted with [commitlint](https://commitlint.js.org/) against
`@commitlint/config-conventional` (enforced by a husky `commit-msg` hook — run
`npm install` once to activate it). Use Conventional Commits:

```
feat(auth): add refresh-token rotation
fix(ws): mark user offline only when last socket closes
chore: scaffold project structure
```

## Build checkpoints

This backend was built checkpoint by checkpoint, each on its own `feature/cp*` branch,
merged into `main` after every checkpoint. See git log / branches for the build history,
including the Next.js -> Fastify rewrite (CP13–CP18), which kept the database and Prisma
schema untouched throughout.

## Security notes

- `npm audit` flags `@fastify/static` (path-traversal via non-canonical URLs / `allowedPath`
  bypass) and transitively `fast-uri`/`find-my-way`. All of the underlying advisories
  require a usage pattern this app doesn't have: per-path `allowedPath` guards on static
  files (we serve `public/` fully open, matching Next.js's original behavior), Fastify's
  HTTP/2 support (never enabled here), or direct calls to `fast-uri`'s policy-enforcement
  functions (we validate everything with zod, never Fastify's built-in JSON-schema
  validation, so that code path is never reached). Fixing them properly requires Fastify
  v5, which needs Node 20+ — a bigger jump than this rewrite's scope; revisit if the
  Node version target changes.
- Passwords hashed with bcrypt; access tokens short-lived (5 min); refresh tokens are
  signed JWTs whose hash is persisted so they can be rotated and revoked.
- All secrets via environment variables — never hardcoded (see `.env.example`).

## Definition of Done

Verified end-to-end against the real `docker compose up` stack (Postgres 16 + migrate + api + ws):

- [x] `docker compose up` brings up Postgres + migrated schema + seeded data + API (3000) + WS (8080) with no manual steps.
- [x] `/api/auth/login` issues a working session against real (seeded) users.
- [x] `/api/chats` returns data shaped exactly like the client's `ChatListItem[]`.
- [x] A message sent via `message:send` over WS is persisted, appears via `message:new` on a second client, and its receipt transitions `SENT` → `DELIVERED` → `SEEN`.
- [x] Typing indicators (`typing:start` → `typing:update`) and online/last-seen presence (`presence:update` on connect/disconnect, deduplicated across shared chats) work over WS.
- [x] A message sent via REST (`POST /api/messages`) also fans out over WS (`message:new`) to connected clients, confirmed live.
- [x] `POST /api/attachments` persists to the `nivichat_uploads` volume and is immediately reachable at its returned URL.
