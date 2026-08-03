import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { MESSAGE_INCLUDE, toMessageDTO } from "@/lib/serializers";
import { notifyWs } from "@/lib/wsBroadcast";
import { ApiError, NotFoundError } from "@/lib/errors";

const attachmentInputSchema = z.object({
  type: z.enum(["IMAGE", "AUDIO", "FILE", "VIDEO"]),
  url: z.string().url(),
  fileName: z.string().optional(),
  fileSize: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  duration: z.number().int().optional(),
  waveform: z.unknown().optional(),
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

// POST /api/messages — send a message; also broadcast message:new over WS.
export const POST = withAuth(async (req, _ctx, auth) => {
  const body = await parseJsonBody(req, sendMessageSchema);

  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_userId: { chatId: body.chatId, userId: auth.sub } },
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
    .filter((id) => id !== auth.sub);

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        chatId: body.chatId,
        senderId: auth.sub,
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

  return buildSuccess(dto, "Message sent", 201);
});
