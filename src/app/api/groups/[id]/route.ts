import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { GROUP_INCLUDE, toGroupDTO } from "@/lib/serializers";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

async function loadGroupForMember(groupId: string, userId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: GROUP_INCLUDE
  });
  if (!group) throw new NotFoundError("Group not found");

  const membership = group.members.find((m) => m.userId === userId);
  if (!membership) throw new NotFoundError("Group not found");

  return { group, membership };
}

// GET /api/groups/[id]
export const GET = withAuth(async (_req, ctx, auth) => {
  const { group } = await loadGroupForMember(ctx.params.id, auth.sub);
  return buildSuccess(toGroupDTO(group));
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    avatarUrl: z.string().url().nullable().optional(),
    description: z.string().max(280).nullable().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

// PATCH /api/groups/[id] — admin only.
export const PATCH = withAuth(async (req, ctx, auth) => {
  const { membership } = await loadGroupForMember(ctx.params.id, auth.sub);
  if (membership.role !== "ADMIN") {
    throw new ForbiddenError("Only a group admin can update this group");
  }

  const body = await parseJsonBody(req, patchSchema);
  const updated = await prisma.group.update({
    where: { id: ctx.params.id },
    data: body,
    include: GROUP_INCLUDE
  });

  return buildSuccess(toGroupDTO(updated), "Group updated");
});

// DELETE /api/groups/[id] — disband, admin only.
export const DELETE = withAuth(async (_req, ctx, auth) => {
  const { group, membership } = await loadGroupForMember(ctx.params.id, auth.sub);
  if (membership.role !== "ADMIN") {
    throw new ForbiddenError("Only a group admin can disband this group");
  }

  // Cascades: Group -> Chat (chatId unique FK, onDelete Cascade) removes
  // ChatParticipant/Message/Call rows for the chat too.
  await prisma.chat.delete({ where: { id: group.chatId } });

  return buildSuccess(null, "Group disbanded");
});
