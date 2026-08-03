import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { MESSAGE_INCLUDE, toMessageDTO } from "@/lib/serializers";
import { notifyWs } from "@/lib/wsBroadcast";
import { ApiError, ForbiddenError, NotFoundError } from "@/lib/errors";

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

// GET /api/messages/[id]
export const GET = withAuth(async (_req, ctx, auth) => {
  await loadMessageForParticipant(ctx.params.id, auth.sub);
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: ctx.params.id },
    include: MESSAGE_INCLUDE
  });
  return buildSuccess(toMessageDTO(message));
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), text: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("delete") }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["SENDING", "SENT", "DELIVERED", "SEEN", "READ", "MISSED"])
  })
]);

// PATCH /api/messages/[id] — edit text / soft-delete / update receipt status.
export const PATCH = withAuth(async (req, ctx, auth) => {
  const messageId = ctx.params.id;
  const message = await loadMessageForParticipant(messageId, auth.sub);
  const body = await parseJsonBody(req, patchSchema);

  if (body.action === "status") {
    const receipt = await prisma.messageReceipt.upsert({
      where: { messageId_userId: { messageId, userId: auth.sub } },
      update: { status: body.status },
      create: { messageId, userId: auth.sub, status: body.status }
    });
    void notifyWs("message:status", { messageId, userId: auth.sub, status: receipt.status });
    return buildSuccess(receipt, "Receipt updated");
  }

  if (message.senderId !== auth.sub) {
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

  return buildSuccess(dto, body.action === "edit" ? "Message edited" : "Message deleted");
});

// DELETE /api/messages/[id] — soft-delete alias for clients that prefer a plain DELETE.
export const DELETE = withAuth(async (_req, ctx, auth) => {
  const messageId = ctx.params.id;
  const message = await loadMessageForParticipant(messageId, auth.sub);

  if (message.senderId !== auth.sub) {
    throw new ForbiddenError("Only the sender can delete this message");
  }
  if (message.isDeleted) {
    return buildSuccess(null, "Message already deleted");
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { isDeleted: true, deletedAt: new Date(), text: null },
    include: MESSAGE_INCLUDE
  });

  void notifyWs("message:update", toMessageDTO(updated));

  return buildSuccess(null, "Message deleted");
});
