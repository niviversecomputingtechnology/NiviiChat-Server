/**
 * Standalone WebSocket process (not part of Next.js — API routes are
 * request/response and can't hold persistent connections). Shares the same
 * Prisma schema/DB as the REST layer so both stay consistent; REST calls
 * POST /internal/broadcast on this same HTTP server to fan out changes it
 * made (message sent/edited/deleted) to connected WS clients.
 */

require("dotenv").config();

const http = require("http");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const PORT = Number(process.env.WS_PORT || 8080);
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "";
const WS_INTERNAL_SECRET = process.env.WS_INTERNAL_SECRET || "";
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

/** userId -> Set<WebSocket>, so a user can have multiple connected devices. */
const connectionsByUser = new Map();

function log(level, message, extra) {
  const line = { level, message, ts: new Date().toISOString(), ...extra };
  (level === "error" ? console.error : console.log)(JSON.stringify(line));
}

function send(ws, event, data) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event, data }));
}

function sendError(ws, message, code) {
  send(ws, "error", { message, code });
}

function registerConnection(userId, ws) {
  let set = connectionsByUser.get(userId);
  if (!set) {
    set = new Set();
    connectionsByUser.set(userId, set);
  }
  set.add(ws);
}

function unregisterConnection(userId, ws) {
  const set = connectionsByUser.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) {
    connectionsByUser.delete(userId);
    return true; // last socket for this user closed
  }
  return false;
}

function sendToUser(userId, event, data) {
  const set = connectionsByUser.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, event, data);
}

async function chatParticipantIds(chatId) {
  const rows = await prisma.chatParticipant.findMany({
    where: { chatId },
    select: { userId: true }
  });
  return rows.map((r) => r.userId);
}

async function broadcastToChat(chatId, event, data, opts = {}) {
  const participantIds = await chatParticipantIds(chatId);
  for (const userId of participantIds) {
    if (opts.excludeUserId && userId === opts.excludeUserId) continue;
    sendToUser(userId, event, data);
  }
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    isVerified: user.isVerified,
    isOnline: user.isOnline,
    lastSeenAt: user.lastSeenAt,
    createdAt: user.createdAt
  };
}

function toMessageDTO(message) {
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    sender: toPublicUser(message.sender),
    type: message.type,
    text: message.isDeleted ? null : message.text,
    replyToId: message.replyToId,
    isEdited: message.isEdited,
    editedAt: message.editedAt,
    isDeleted: message.isDeleted,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
    attachments: message.attachments,
    reactions: message.reactions
  };
}

// --- auth handshake ---

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_ACCESS_SECRET);
}

async function handleAuth(ws, data) {
  if (!data || typeof data.token !== "string") {
    sendError(ws, "auth requires { token }", "AUTH_BAD_REQUEST");
    return;
  }

  let payload;
  try {
    payload = verifyAccessToken(data.token);
  } catch {
    sendError(ws, "Invalid or expired access token", "AUTH_INVALID_TOKEN");
    ws.close(4001, "Invalid token");
    return;
  }

  ws.authenticated = true;
  ws.userId = payload.sub;
  ws.username = payload.username;
  clearTimeout(ws.authTimer);

  const wasOffline = !connectionsByUser.has(ws.userId);
  registerConnection(ws.userId, ws);

  if (wasOffline) {
    const user = await prisma.user.update({
      where: { id: ws.userId },
      data: { isOnline: true }
    });
    const participantChats = await prisma.chatParticipant.findMany({
      where: { userId: ws.userId },
      select: { chatId: true }
    });
    for (const { chatId } of participantChats) {
      await broadcastToChat(
        chatId,
        "presence:update",
        { userId: user.id, isOnline: true, lastSeenAt: user.lastSeenAt },
        { excludeUserId: user.id }
      );
    }
  }

  send(ws, "auth", { ok: true, userId: ws.userId });
}

// --- message:send ---

async function handleMessageSend(ws, data) {
  if (!ws.authenticated) return sendError(ws, "Not authenticated", "UNAUTHENTICATED");

  const { chatId, type, text, replyToId, attachments } = data || {};
  if (!chatId || typeof chatId !== "string") {
    return sendError(ws, "message:send requires chatId", "VALIDATION");
  }

  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_userId: { chatId, userId: ws.userId } },
    include: { chat: { include: { participants: true } } }
  });
  if (!participant) {
    return sendError(ws, "Chat not found", "NOT_FOUND");
  }

  const messageType = type || "TEXT";
  if (messageType === "TEXT" && !text) {
    return sendError(ws, "text is required for TEXT messages", "VALIDATION");
  }

  const otherUserIds = participant.chat.participants
    .map((p) => p.userId)
    .filter((id) => id !== ws.userId);

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        chatId,
        senderId: ws.userId,
        type: messageType,
        text: text ?? null,
        replyToId: replyToId ?? null,
        attachments: Array.isArray(attachments) && attachments.length
          ? { create: attachments }
          : undefined,
        receipts: {
          create: otherUserIds.map((userId) => ({ userId, status: "SENT" }))
        }
      },
      include: { sender: true, attachments: true, reactions: true }
    }),
    prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }),
    prisma.chatParticipant.updateMany({
      where: { chatId, userId: { in: otherUserIds } },
      data: { unreadCount: { increment: 1 } }
    })
  ]);

  const dto = toMessageDTO(message);
  // Fan out to every participant, including the sender's other devices.
  await broadcastToChat(chatId, "message:new", dto);
}

// --- typing:start / typing:stop ---

async function handleTyping(ws, data, isTyping) {
  if (!ws.authenticated) return sendError(ws, "Not authenticated", "UNAUTHENTICATED");
  const { chatId } = data || {};
  if (!chatId) return sendError(ws, "typing events require chatId", "VALIDATION");

  await broadcastToChat(
    chatId,
    "typing:update",
    { chatId, userId: ws.userId, isTyping },
    { excludeUserId: ws.userId }
  );
}

// --- message:read ---

async function handleMessageRead(ws, data) {
  if (!ws.authenticated) return sendError(ws, "Not authenticated", "UNAUTHENTICATED");
  const { chatId, messageId } = data || {};
  if (!chatId || !messageId) {
    return sendError(ws, "message:read requires chatId and messageId", "VALIDATION");
  }

  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_userId: { chatId, userId: ws.userId } }
  });
  if (!participant) return sendError(ws, "Chat not found", "NOT_FOUND");

  await prisma.messageReceipt.upsert({
    where: { messageId_userId: { messageId, userId: ws.userId } },
    update: { status: "SEEN" },
    create: { messageId, userId: ws.userId, status: "SEEN" }
  });

  await prisma.chatParticipant.update({
    where: { id: participant.id },
    data: { unreadCount: 0, lastReadAt: new Date() }
  });

  await broadcastToChat(
    chatId,
    "message:status",
    { messageId, userId: ws.userId, status: "SEEN" },
    { excludeUserId: ws.userId }
  );
}

// --- presence:ping ---

async function handlePresencePing(ws) {
  if (!ws.authenticated) return sendError(ws, "Not authenticated", "UNAUTHENTICATED");
  await prisma.user.update({ where: { id: ws.userId }, data: { lastSeenAt: new Date() } });
}

// --- call:signal / call:incoming relay ---
// The event table (README §7) documents call:incoming/call:signal as
// server->client events for WebRTC offer/answer/ICE relay; the matching
// client->server event isn't named there, so this server accepts a single
// "call:signal" from the caller/callee and relays it: the first "offer"
// reaches the callee as call:incoming, everything after (answer,
// ice-candidate, end) relays as call:signal.
async function handleCallSignal(ws, data) {
  if (!ws.authenticated) return sendError(ws, "Not authenticated", "UNAUTHENTICATED");
  const { chatId, toUserId, type, payload } = data || {};
  if (!chatId || !toUserId || !type) {
    return sendError(ws, "call:signal requires chatId, toUserId, type", "VALIDATION");
  }

  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_userId: { chatId, userId: ws.userId } }
  });
  if (!participant) return sendError(ws, "Chat not found", "NOT_FOUND");

  const event = type === "offer" ? "call:incoming" : "call:signal";
  sendToUser(toUserId, event, { chatId, fromUserId: ws.userId, type, payload });
}

async function dispatch(ws, envelope) {
  const { event, data } = envelope;
  switch (event) {
    case "auth":
      return handleAuth(ws, data);
    case "message:send":
      return handleMessageSend(ws, data);
    case "typing:start":
      return handleTyping(ws, data, true);
    case "typing:stop":
      return handleTyping(ws, data, false);
    case "message:read":
      return handleMessageRead(ws, data);
    case "presence:ping":
      return handlePresencePing(ws);
    case "call:signal":
      return handleCallSignal(ws, data);
    default:
      return sendError(ws, `Unknown event: ${event}`, "UNKNOWN_EVENT");
  }
}

// --- HTTP: internal REST -> WS broadcast + WS upgrade ---

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/broadcast") {
    if (req.headers["x-internal-secret"] !== WS_INTERNAL_SECRET) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { event, payload } = JSON.parse(body);
        if (payload && payload.chatId) {
          await broadcastToChat(payload.chatId, event, payload);
        }
        res.writeHead(204).end();
      } catch (err) {
        log("error", "internal broadcast failed", { error: String(err) });
        res.writeHead(400).end();
      }
    });
    return;
  }

  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.authenticated = false;
  ws.isAlive = true;

  ws.authTimer = setTimeout(() => {
    if (!ws.authenticated) {
      sendError(ws, "Authentication timeout", "AUTH_TIMEOUT");
      ws.close(4001, "Authentication timeout");
    }
  }, AUTH_TIMEOUT_MS);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let envelope;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, "Message must be valid JSON", "BAD_JSON");
    }
    dispatch(ws, envelope).catch((err) => {
      log("error", "event handler failed", { error: String(err), event: envelope && envelope.event });
      sendError(ws, "Internal server error", "INTERNAL_ERROR");
    });
  });

  ws.on("close", async () => {
    clearTimeout(ws.authTimer);
    if (!ws.authenticated) return;

    const isLastSocket = unregisterConnection(ws.userId, ws);
    if (!isLastSocket) return;

    const user = await prisma.user.update({
      where: { id: ws.userId },
      data: { isOnline: false, lastSeenAt: new Date() }
    });
    const participantChats = await prisma.chatParticipant.findMany({
      where: { userId: ws.userId },
      select: { chatId: true }
    });
    for (const { chatId } of participantChats) {
      await broadcastToChat(
        chatId,
        "presence:update",
        { userId: user.id, isOnline: false, lastSeenAt: user.lastSeenAt },
        { excludeUserId: user.id }
      );
    }
  });
});

// Drop dead connections (no pong within two heartbeat intervals).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  log("info", `ws-server listening on :${PORT}`);
});

async function shutdown(signal) {
  log("info", `${signal} received, shutting down`, {});
  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    sendError(ws, "Server is shutting down", "SERVER_SHUTDOWN");
    ws.close(1001, "Server shutting down");
  }

  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
