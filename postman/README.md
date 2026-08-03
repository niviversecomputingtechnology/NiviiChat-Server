# Postman collection

- `NiviChat-Backend.postman_collection.json` — every REST route, grouped by resource,
  with per-request descriptions (body/query fields, auth requirements, error cases) and
  a WebSocket protocol reference folder for the parts Postman can't run directly.
- `NiviChat-Local.postman_environment.json` — `baseUrl` + the token/id variables the
  collection reads and writes.

## Import

1. Postman → **Import** → select both JSON files (or drag them in).
2. Pick **NiviChat Local** from the environment dropdown (top right).
3. If the API isn't on `http://localhost:3000`, edit the environment's `baseUrl`.
4. Run **Auth → Login** — the seed script's users (`alice@nivichat.dev` /
   `bob@nivichat.dev` / `carol@nivichat.dev`, password `Password123!`) work out of the
   box after `npm run prisma:seed`. Login's test script saves `accessToken` /
   `refreshToken` / `userId` automatically; every other request is already wired to send
   `Authorization: Bearer {{accessToken}}` via the collection's Bearer auth.

Several requests (Search Users, List Chats, Create Direct Chat, Send Message, Create
Group) also save the ids they return (`otherUserId`, `chatId`, `messageId`, `groupId`)
so the rest of the collection can be run in order without manual copy-pasting.
