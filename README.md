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

- [ ] `docker compose up` brings up Postgres + migrated schema + seeded data + API (3000) + WS (8080) with no manual steps.
- [ ] `/api/auth/login` issues a working session against real (seeded) users.
- [ ] `/api/chats` returns data shaped exactly like the client's `ChatListItem[]`.
- [ ] A message sent via `message:send` over WS is persisted, appears via `message:new` on a second client, and shows `sent` → `delivered` → `seen` transitions.
- [ ] Typing indicators and online/last-seen presence work over WS.
