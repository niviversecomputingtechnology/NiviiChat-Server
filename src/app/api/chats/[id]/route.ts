import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody, parseQuery } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { toChatHeader, toMessageDTO } from "@/lib/serializers";
import { NotFoundError } from "@/lib/errors";

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

const messagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

// GET /api/chats/[id] — chat detail + paginated messages (?cursor=&limit=).
export const GET = withAuth(async (req, ctx, auth) => {
  const chatId = ctx.params.id;
  const participant = await requireParticipant(chatId, auth.sub);
  const { cursor, limit } = parseQuery(req, messagesQuerySchema);

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

  return buildSuccess({
    chat: toChatHeader(participant.chat, participant, auth.sub),
    messages: page.map(toMessageDTO),
    nextCursor
  });
});

const patchSchema = z
  .object({
    isPinned: z.boolean().optional(),
    isMuted: z.boolean().optional(),
    isArchived: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

// PATCH /api/chats/[id] — pin / mute / archive (writes ChatParticipant).
export const PATCH = withAuth(async (req, ctx, auth) => {
  const chatId = ctx.params.id;
  const participant = await requireParticipant(chatId, auth.sub);
  const body = await parseJsonBody(req, patchSchema);

  const updated = await prisma.chatParticipant.update({
    where: { id: participant.id },
    data: body
  });

  return buildSuccess(
    {
      isPinned: updated.isPinned,
      isMuted: updated.isMuted,
      isArchived: updated.isArchived
    },
    "Chat updated"
  );
});

// DELETE /api/chats/[id] — leave/delete chat for the current user.
export const DELETE = withAuth(async (_req, ctx, auth) => {
  const chatId = ctx.params.id;
  const participant = await requireParticipant(chatId, auth.sub);

  await prisma.chatParticipant.delete({ where: { id: participant.id } });

  const remaining = await prisma.chatParticipant.count({ where: { chatId } });
  if (remaining === 0) {
    await prisma.chat.delete({ where: { id: chatId } });
  }

  return buildSuccess(null, "Left chat");
});
