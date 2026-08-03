import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { validate } from "../lib/validation";
import { sendSuccess } from "../lib/response";
import { prisma } from "../lib/prisma";
import { MESSAGE_INCLUDE, toMessageDTO } from "../lib/serializers";
import { notifyWs } from "../lib/wsBroadcast";
import { ApiError, ForbiddenError, NotFoundError } from "../lib/errors";

const attachmentInputSchema = z.object({
  type: z.enum(["IMAGE", "AUDIO", "FILE", "VIDEO"]),
  url: z.string().url(),
  fileName: z.string().optional(),
  fileSize: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  duration: z.number().int().optional(),
  waveform: z.any().optional(), // arbitrary JSON; Prisma's Json input type won't accept `unknown`
  thumbnail: z.string().url().optional()
});

const sendMessageSchema = z
  .object({
    chatId: z.string().min(1),
    type: z
      .enum(["TEXT", "IMAGE", "AUDIO", "FILE", "VIDEO", "VIDEO_CALL", "VOICE_CALL"])
      .default("TEXT"),
    text: z.string().min(1).max(4000).optional(),
    replyToId: z.string().optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional()
  })
  .refine((v) => v.type !== "TEXT" || Boolean(v.text?.length), {
    message: "text is required for TEXT messages",
    path: ["text"]
  });

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), text: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("delete") }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["SENDING", "SENT", "DELIVERED", "SEEN", "READ", "MISSED"])
  })
]);

async function loadMessageForParticipant(messageId: string, userId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { chat: { include: { participants: true } } }
  });
  if (!message || !message.chat.participants.some((p) => p.userId === userId)) {
    throw new NotFoundError("Message not found");
  }
  return message;
}

const messageRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // POST /api/messages — send a message; also broadcast message:new over WS.
  fastify.post("/", async (request, reply) => {
    const body = validate(sendMessageSchema, request.body);
    const senderId = request.user.sub;

    const participant = await prisma.chatParticipant.findUnique({
      where: { chatId_userId: { chatId: body.chatId, userId: senderId } },
      include: { chat: { include: { participants: true } } }
    });
    if (!participant) {
      throw new NotFoundError("Chat not found");
    }

    if (body.replyToId) {
      const replyTo = await prisma.message.findUnique({ where: { id: body.replyToId } });
      if (!replyTo || replyTo.chatId !== body.chatId) {
        throw new ApiError("replyToId does not belong to this chat", 400);
      }
    }

    const otherUserIds = participant.chat.participants
      .map((p) => p.userId)
      .filter((id) => id !== senderId);

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          chatId: body.chatId,
          senderId,
          type: body.type,
          text: body.text,
          replyToId: body.replyToId,
          attachments: body.attachments ? { create: body.attachments } : undefined,
          receipts: {
            create: otherUserIds.map((userId) => ({ userId, status: "SENT" as const }))
          }
        },
        include: MESSAGE_INCLUDE
      }),
      prisma.chat.update({ where: { id: body.chatId }, data: { updatedAt: new Date() } }),
      prisma.chatParticipant.updateMany({
        where: { chatId: body.chatId, userId: { in: otherUserIds } },
        data: { unreadCount: { increment: 1 } }
      })
    ]);

    const dto = toMessageDTO(message);
    void notifyWs("message:new", dto);

    return sendSuccess(reply, dto, "Message sent", 201);
  });

  // GET /api/messages/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    await loadMessageForParticipant(request.params.id, request.user.sub);
    const message = await prisma.message.findUniqueOrThrow({
      where: { id: request.params.id },
      include: MESSAGE_INCLUDE
    });
    return sendSuccess(reply, toMessageDTO(message));
  });

  // PATCH /api/messages/:id — edit text / soft-delete / update receipt status.
  fastify.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const messageId = request.params.id;
    const userId = request.user.sub;
    const message = await loadMessageForParticipant(messageId, userId);
    const body = validate(patchSchema, request.body);

    if (body.action === "status") {
      const receipt = await prisma.messageReceipt.upsert({
        where: { messageId_userId: { messageId, userId } },
        update: { status: body.status },
        create: { messageId, userId, status: body.status }
      });
      void notifyWs("message:status", { messageId, userId, status: receipt.status });
      return sendSuccess(reply, receipt, "Receipt updated");
    }

    if (message.senderId !== userId) {
      throw new ForbiddenError("Only the sender can modify this message");
    }
    if (message.isDeleted) {
      throw new ApiError("Message has been deleted", 400);
    }

    const updated =
      body.action === "edit"
        ? await prisma.message.update({
            where: { id: messageId },
            data: { text: body.text, isEdited: true, editedAt: new Date() },
            include: MESSAGE_INCLUDE
          })
        : await prisma.message.update({
            where: { id: messageId },
            data: { isDeleted: true, deletedAt: new Date(), text: null },
            include: MESSAGE_INCLUDE
          });

    const dto = toMessageDTO(updated);
    void notifyWs("message:update", dto);

    return sendSuccess(reply, dto, body.action === "edit" ? "Message edited" : "Message deleted");
  });

  // DELETE /api/messages/:id — soft-delete alias for clients that prefer a plain DELETE.
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const messageId = request.params.id;
    const userId = request.user.sub;
    const message = await loadMessageForParticipant(messageId, userId);

    if (message.senderId !== userId) {
      throw new ForbiddenError("Only the sender can delete this message");
    }
    if (message.isDeleted) {
      return sendSuccess(reply, null, "Message already deleted");
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { isDeleted: true, deletedAt: new Date(), text: null },
      include: MESSAGE_INCLUDE
    });

    void notifyWs("message:update", toMessageDTO(updated));

    return sendSuccess(reply, null, "Message deleted");
  });
};

export default messageRoutes;
