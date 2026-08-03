import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody, parseQuery } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { GROUP_INCLUDE, toGroupDTO } from "@/lib/serializers";
import { ApiError, ForbiddenError, NotFoundError } from "@/lib/errors";

async function loadGroupForMember(groupId: string, userId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId }, include: GROUP_INCLUDE });
  if (!group) throw new NotFoundError("Group not found");

  const membership = group.members.find((m) => m.userId === userId);
  if (!membership) throw new NotFoundError("Group not found");

  return { group, membership };
}

const addMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(256)
});

// POST /api/groups/[id]/members — add members, admin only.
export const POST = withAuth(async (req, ctx, auth) => {
  const groupId = ctx.params.id;
  const { group, membership } = await loadGroupForMember(groupId, auth.sub);
  if (membership.role !== "ADMIN") {
    throw new ForbiddenError("Only a group admin can add members");
  }

  const { userIds } = await parseJsonBody(req, addMembersSchema);
  const existingIds = new Set(group.members.map((m) => m.userId));
  const newIds = Array.from(new Set(userIds.filter((id) => !existingIds.has(id))));

  if (newIds.length === 0) {
    return buildSuccess(toGroupDTO(group), "No new members to add");
  }

  const foundUsers = await prisma.user.count({ where: { id: { in: newIds } } });
  if (foundUsers !== newIds.length) {
    throw new ApiError("One or more userIds do not exist", 400);
  }

  await prisma.$transaction([
    prisma.chatParticipant.createMany({
      data: newIds.map((userId) => ({ chatId: group.chatId, userId })),
      skipDuplicates: true
    }),
    prisma.groupMember.createMany({
      data: newIds.map((userId) => ({ groupId, userId, role: "MEMBER" as const })),
      skipDuplicates: true
    })
  ]);

  const updated = await prisma.group.findUniqueOrThrow({ where: { id: groupId }, include: GROUP_INCLUDE });
  return buildSuccess(toGroupDTO(updated), "Members added");
});

const removeMemberSchema = z.object({
  userId: z.string().min(1)
});

// DELETE /api/groups/[id]/members?userId= — admins can remove anyone; a
// member can remove (i.e. leave as) themselves.
export const DELETE = withAuth(async (req, ctx, auth) => {
  const groupId = ctx.params.id;
  const { group, membership } = await loadGroupForMember(groupId, auth.sub);
  const { userId: targetUserId } = parseQuery(req, removeMemberSchema);

  if (targetUserId !== auth.sub && membership.role !== "ADMIN") {
    throw new ForbiddenError("Only a group admin can remove other members");
  }

  const target = group.members.find((m) => m.userId === targetUserId);
  if (!target) {
    throw new NotFoundError("That user is not a member of this group");
  }

  await prisma.$transaction([
    prisma.groupMember.delete({ where: { groupId_userId: { groupId, userId: targetUserId } } }),
    prisma.chatParticipant.deleteMany({ where: { chatId: group.chatId, userId: targetUserId } })
  ]);

  return buildSuccess(null, targetUserId === auth.sub ? "Left group" : "Member removed");
});
