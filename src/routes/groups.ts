import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { validate } from "../lib/validation";
import { sendSuccess } from "../lib/response";
import { prisma } from "../lib/prisma";
import { GROUP_INCLUDE, toGroupDTO } from "../lib/serializers";
import { ApiError, ForbiddenError, NotFoundError } from "../lib/errors";

async function loadGroupForMember(groupId: string, userId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId }, include: GROUP_INCLUDE });
  if (!group) throw new NotFoundError("Group not found");

  const membership = group.members.find((m) => m.userId === userId);
  if (!membership) throw new NotFoundError("Group not found");

  return { group, membership };
}

const createGroupSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.string().url().optional(),
  description: z.string().max(280).optional(),
  memberIds: z.array(z.string().min(1)).min(1).max(256)
});

const patchGroupSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    avatarUrl: z.string().url().nullable().optional(),
    description: z.string().max(280).nullable().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

const addMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(256)
});

const removeMemberSchema = z.object({
  userId: z.string().min(1)
});

const groupRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // POST /api/groups — multi-stage group creation (name, avatar, description, memberIds).
  fastify.post("/", async (request, reply) => {
    const body = validate(createGroupSchema, request.body);
    const currentUserId = request.user.sub;

    const memberIds = Array.from(new Set(body.memberIds.filter((id) => id !== currentUserId)));
    if (memberIds.length === 0) {
      throw new ApiError("A group needs at least one other member", 400);
    }

    const foundUsers = await prisma.user.count({ where: { id: { in: memberIds } } });
    if (foundUsers !== memberIds.length) {
      throw new ApiError("One or more memberIds do not exist", 400);
    }

    const chat = await prisma.chat.create({
      data: {
        type: "GROUP",
        participants: {
          create: [{ userId: currentUserId }, ...memberIds.map((userId) => ({ userId }))]
        },
        group: {
          create: {
            name: body.name,
            avatarUrl: body.avatarUrl,
            description: body.description,
            createdBy: currentUserId,
            members: {
              create: [
                { userId: currentUserId, role: "ADMIN" },
                ...memberIds.map((userId) => ({ userId, role: "MEMBER" as const }))
              ]
            }
          }
        }
      },
      include: { group: { include: GROUP_INCLUDE } }
    });

    return sendSuccess(reply, toGroupDTO(chat.group!), "Group created", 201);
  });

  // GET /api/groups/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { group } = await loadGroupForMember(request.params.id, request.user.sub);
    return sendSuccess(reply, toGroupDTO(group));
  });

  // PATCH /api/groups/:id — admin only.
  fastify.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const groupId = request.params.id;
    const { membership } = await loadGroupForMember(groupId, request.user.sub);
    if (membership.role !== "ADMIN") {
      throw new ForbiddenError("Only a group admin can update this group");
    }

    const body = validate(patchGroupSchema, request.body);
    const updated = await prisma.group.update({
      where: { id: groupId },
      data: body,
      include: GROUP_INCLUDE
    });

    return sendSuccess(reply, toGroupDTO(updated), "Group updated");
  });

  // DELETE /api/groups/:id — disband, admin only.
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { group, membership } = await loadGroupForMember(request.params.id, request.user.sub);
    if (membership.role !== "ADMIN") {
      throw new ForbiddenError("Only a group admin can disband this group");
    }

    // Cascades: Group -> Chat (chatId unique FK, onDelete Cascade) removes
    // ChatParticipant/Message/Call rows for the chat too.
    await prisma.chat.delete({ where: { id: group.chatId } });

    return sendSuccess(reply, null, "Group disbanded");
  });

  // POST /api/groups/:id/members — add members, admin only.
  fastify.post<{ Params: { id: string } }>("/:id/members", async (request, reply) => {
    const groupId = request.params.id;
    const { group, membership } = await loadGroupForMember(groupId, request.user.sub);
    if (membership.role !== "ADMIN") {
      throw new ForbiddenError("Only a group admin can add members");
    }

    const { userIds } = validate(addMembersSchema, request.body);
    const existingIds = new Set(group.members.map((m) => m.userId));
    const newIds = Array.from(new Set(userIds.filter((id) => !existingIds.has(id))));

    if (newIds.length === 0) {
      return sendSuccess(reply, toGroupDTO(group), "No new members to add");
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
    return sendSuccess(reply, toGroupDTO(updated), "Members added");
  });

  // DELETE /api/groups/:id/members?userId= — admins can remove anyone; a
  // member can remove (i.e. leave as) themselves.
  fastify.delete<{ Params: { id: string } }>("/:id/members", async (request, reply) => {
    const groupId = request.params.id;
    const currentUserId = request.user.sub;
    const { group, membership } = await loadGroupForMember(groupId, currentUserId);
    const { userId: targetUserId } = validate(removeMemberSchema, request.query);

    if (targetUserId !== currentUserId && membership.role !== "ADMIN") {
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

    return sendSuccess(reply, null, targetUserId === currentUserId ? "Left group" : "Member removed");
  });
};

export default groupRoutes;
