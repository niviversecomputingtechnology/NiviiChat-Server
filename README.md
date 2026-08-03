# NiviChat Backend

Server platform for NiviChat: Next.js REST API (`/api/...`) + a standalone Node WebSocket
server (`src/ws-server.js`, port 8080), sharing one PostgreSQL database through Prisma.

This backend is built to match the existing mobile client contract exactly (response
envelope, auth scheme, resource naming) — see `src/lib/response.ts` and `src/lib/auth.ts`.

## Stack

- Node.js 18 LTS+
- PostgreSQL 15/16
- Prisma (schema-first; `db push` in dev, not `migrate`)
- Next.js API routes
- Custom `ws` WebSocket server, separate process, port 8080
- Docker Compose (db + migrate + api + ws)

## Local development

```bash
cp .env.example .env   # fill in real secrets
npm install
npm run prisma:generate
npm run prisma:push
npm run prisma:seed
npm run dev             # Next.js API on :3000
npm run ws               # WebSocket server on :8080 (separate terminal)
```

## Docker

```bash
docker compose build
docker compose up -d
docker compose logs -f api ws
docker compose down      # keeps the pgdata volume
```

## API reference

All routes are mounted under `/api`, require `Authorization: Bearer <accessToken>` unless
noted, and return the envelope in `src/lib/response.ts`
(`{ status, message, data, app_version }` / `{ status:false, message, error, trace_id }`).
List endpoints are cursor-paginated (`?cursor=&limit=`).

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | ❌ | Create account |
| POST | `/api/auth/login` | ❌ | `{ accessToken, refreshToken, user }` |
| POST | `/api/auth/refresh-token` | refresh token | Rotate refresh token, mint new access token |
| POST | `/api/auth/logout` | ✅ | Revoke a refresh token |
| GET/PATCH | `/api/users/me` | ✅ | Current profile |
| GET | `/api/users?query=` | ✅ | Search users |
| GET | `/api/users/[id]` | ✅ | Public profile lookup |
| GET/POST | `/api/chats` | ✅ | List chats / create-or-get a direct chat |
| GET/PATCH/DELETE | `/api/chats/[id]` | ✅ | Detail + paginated messages / pin-mute-archive / leave |
| POST | `/api/messages` | ✅ | Send (also broadcasts `message:new` over WS) |
| GET/PATCH/DELETE | `/api/messages/[id]` | ✅ | Detail / edit-delete-receipt-status / soft-delete |
| POST | `/api/groups` | ✅ | Create group |
| GET/PATCH/DELETE | `/api/groups/[id]` | ✅ | Detail / update (admin) / disband (admin) |
| POST/DELETE | `/api/groups/[id]/members` | ✅ | Add (admin) / remove (admin, or self-leave) |
| POST | `/api/attachments` | ✅ | Multipart upload, returns `{ url, type, fileName, fileSize }` |
| GET/POST | `/api/calls` | ✅ | History / log a call |

## WebSocket events (`ws-server.js`, port 8080)

First message after connecting must be `{ event: "auth", data: { token } }` within 5s.

| Client → Server | Server → Client |
|---|---|
| `auth` | `auth` (ack) |
| `message:send` | `message:new` |
| `typing:start` / `typing:stop` | `typing:update` |
| `message:read` | `message:status`, `presence:update` |
| `presence:ping` | `message:update` (edit/delete, extends the documented set) |
| `call:signal` | `call:incoming` / `call:signal`, `error` |

## Project structure

```
prisma/                  # schema.prisma, seed.ts
src/app/api/              # Next.js route handlers (auth, users, chats, messages, groups, attachments, calls)
src/lib/                  # prisma client, jwt/auth, response envelope, middleware
src/ws-server.js           # standalone WebSocket process
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
merged into `main` after every checkpoint. See git log / branches for the build history.

## Definition of Done

Verified end-to-end against the real `docker compose up` stack (Postgres 16 + migrate + api + ws):

- [x] `docker compose up` brings up Postgres + migrated schema + seeded data + API (3000) + WS (8080) with no manual steps.
- [x] `/api/auth/login` issues a working session against real (seeded) users.
- [x] `/api/chats` returns data shaped exactly like the client's `ChatListItem[]`.
- [x] A message sent via `message:send` over WS is persisted, appears via `message:new` on a second client, and its receipt transitions `SENT` → `SEEN` via `message:read` / `message:status`.
- [x] Typing indicators (`typing:start` → `typing:update`) and online/last-seen presence (`presence:update` on connect/disconnect, deduplicated across shared chats) work over WS.
