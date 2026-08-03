import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { validate } from "../lib/validation";
import { sendSuccess } from "../lib/response";
import { prisma } from "../lib/prisma";
import { toChatHeader, toChatListItem, toMessageDTO } from "../lib/serializers";
import { ApiError, NotFoundError } from "../lib/errors";

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

async function requireParticipant(chatId: string, userId: string) {
  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_userId: { chatId, userId } },
    include: {
      chat: {
        include: {
          participants: { include: { user: true } },
          group: true
        }
      }
    }
  });
  if (!participant) {
    throw new NotFoundError("Chat not found");
  }
  return participant;
}

const chatQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true")
});

const createChatSchema = z.object({
  userId: z.string().min(1)
});

const messagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const patchChatSchema = z
  .object({
    isPinned: z.boolean().optional(),
    isMuted: z.boolean().optional(),
    isArchived: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // GET /api/chats — list chats for the current user, shaped as ChatListItem[].
  fastify.get("/", async (request, reply) => {
    const { includeArchived } = validate(chatQuerySchema, request.query);

    const rows = await prisma.chatParticipant.findMany({
      where: {
        userId: request.user.sub,
        ...(includeArchived ? {} : { isArchived: false })
      },
      include: CHAT_INCLUDE,
      orderBy: [{ isPinned: "desc" }, { chat: { updatedAt: "desc" } }]
    });

    return sendSuccess(reply, rows.map((row) => toChatListItem(row, request.user.sub)));
  });

  // POST /api/chats — create (or return existing) direct chat with another user.
  fastify.post("/", async (request, reply) => {
    const { userId } = validate(createChatSchema, request.body);
    const currentUserId = request.user.sub;

    if (userId === currentUserId) {
      throw new ApiError("Cannot start a chat with yourself", 400);
    }

    const otherUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!otherUser) {
      throw new NotFoundError("Target user not found");
    }

    const existing = await prisma.chat.findFirst({
      where: {
        type: "DIRECT",
        AND: [{ participants: { some: { userId: currentUserId } } }, { participants: { some: { userId } } }]
      },
      include: CHAT_INCLUDE.chat.include
    });

    const chat =
      existing ??
      (await prisma.chat.create({
        data: {
          type: "DIRECT",
          participants: { create: [{ userId: currentUserId }, { userId }] }
        },
        include: CHAT_INCLUDE.chat.include
      }));

    const participantRow = await prisma.chatParticipant.findUniqueOrThrow({
      where: { chatId_userId: { chatId: chat.id, userId: currentUserId } },
      include: CHAT_INCLUDE
    });

    return sendSuccess(
      reply,
      toChatListItem(participantRow, currentUserId),
      existing ? "Chat already exists" : "Chat created",
      existing ? 200 : 201
    );
  });

  // GET /api/chats/:id — chat detail + paginated messages (?cursor=&limit=).
  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const chatId = request.params.id;
    const participant = await requireParticipant(chatId, request.user.sub);
    const { cursor, limit } = validate(messagesQuerySchema, request.query);

    const page = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { attachments: true, sender: true, reactions: true }
    });

    let nextCursor: string | null = null;
    if (page.length > limit) {
      nextCursor = page.pop()!.id;
    }

    await prisma.chatParticipant.update({
      where: { id: participant.id },
      data: { unreadCount: 0, lastReadAt: new Date() }
    });

    return sendSuccess(reply, {
      chat: toChatHeader(participant.chat, participant, request.user.sub),
      messages: page.map(toMessageDTO),
      nextCursor
    });
  });

  // PATCH /api/chats/:id — pin / mute / archive (writes ChatParticipant).
  fastify.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const chatId = request.params.id;
    const participant = await requireParticipant(chatId, request.user.sub);
    const body = validate(patchChatSchema, request.body);

    const updated = await prisma.chatParticipant.update({
      where: { id: participant.id },
      data: body
    });

    return sendSuccess(
      reply,
      { isPinned: updated.isPinned, isMuted: updated.isMuted, isArchived: updated.isArchived },
      "Chat updated"
    );
  });

  // DELETE /api/chats/:id — leave/delete chat for the current user.
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const chatId = request.params.id;
    const participant = await requireParticipant(chatId, request.user.sub);

    await prisma.chatParticipant.delete({ where: { id: participant.id } });

    const remaining = await prisma.chatParticipant.count({ where: { chatId } });
    if (remaining === 0) {
      await prisma.chat.delete({ where: { id: chatId } });
    }

    return sendSuccess(reply, null, "Left chat");
  });
};

export default chatRoutes;
