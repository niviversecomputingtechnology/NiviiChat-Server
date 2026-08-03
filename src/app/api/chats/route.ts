import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody, parseQuery } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { toChatListItem } from "@/lib/serializers";
import { ApiError, NotFoundError } from "@/lib/errors";

const chatQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true")
});

const CHAT_INCLUDE = {
  chat: {
    include: {
      participants: { include: { user: true } },
      group: true,
      messages: {
        orderBy: { createdAt: "desc" as const },
        take: 1,
        include: { attachments: true, sender: true, reactions: true }
      }
    }
  }
} as const;

// GET /api/chats — list chats for the current user, shaped as ChatListItem[].
export const GET = withAuth(async (req, _ctx, auth) => {
  const { includeArchived } = parseQuery(req, chatQuerySchema);

  const rows = await prisma.chatParticipant.findMany({
    where: {
      userId: auth.sub,
      ...(includeArchived ? {} : { isArchived: false })
    },
    include: CHAT_INCLUDE,
    orderBy: [{ isPinned: "desc" }, { chat: { updatedAt: "desc" } }]
  });

  return buildSuccess(rows.map((row) => toChatListItem(row, auth.sub)));
});

const createChatSchema = z.object({
  userId: z.string().min(1)
});

// POST /api/chats — create (or return existing) direct chat with another user.
export const POST = withAuth(async (req, _ctx, auth) => {
  const { userId } = await parseJsonBody(req, createChatSchema);

  if (userId === auth.sub) {
    throw new ApiError("Cannot start a chat with yourself", 400);
  }

  const otherUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!otherUser) {
    throw new NotFoundError("Target user not found");
  }

  const existing = await prisma.chat.findFirst({
    where: {
      type: "DIRECT",
      AND: [
        { participants: { some: { userId: auth.sub } } },
        { participants: { some: { userId } } }
      ]
    },
    include: CHAT_INCLUDE.chat.include
  });

  const chat =
    existing ??
    (await prisma.chat.create({
      data: {
        type: "DIRECT",
        participants: { create: [{ userId: auth.sub }, { userId }] }
      },
      include: CHAT_INCLUDE.chat.include
    }));

  const participantRow = await prisma.chatParticipant.findUniqueOrThrow({
    where: { chatId_userId: { chatId: chat.id, userId: auth.sub } },
    include: CHAT_INCLUDE
  });

  return buildSuccess(
    toChatListItem(participantRow, auth.sub),
    existing ? "Chat already exists" : "Chat created",
    existing ? 200 : 201
  );
});
