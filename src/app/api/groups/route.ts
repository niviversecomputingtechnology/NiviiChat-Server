import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { GROUP_INCLUDE, toGroupDTO } from "@/lib/serializers";
import { ApiError } from "@/lib/errors";

const createGroupSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.string().url().optional(),
  description: z.string().max(280).optional(),
  memberIds: z.array(z.string().min(1)).min(1).max(256)
});

// POST /api/groups — multi-stage group creation (name, avatar, description, memberIds).
export const POST = withAuth(async (req, _ctx, auth) => {
  const body = await parseJsonBody(req, createGroupSchema);

  const memberIds = Array.from(new Set(body.memberIds.filter((id) => id !== auth.sub)));
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
        create: [{ userId: auth.sub }, ...memberIds.map((userId) => ({ userId }))]
      },
      group: {
        create: {
          name: body.name,
          avatarUrl: body.avatarUrl,
          description: body.description,
          createdBy: auth.sub,
          members: {
            create: [
              { userId: auth.sub, role: "ADMIN" },
              ...memberIds.map((userId) => ({ userId, role: "MEMBER" as const }))
            ]
          }
        }
      }
    },
    include: { group: { include: GROUP_INCLUDE } }
  });

  return buildSuccess(toGroupDTO(chat.group!), "Group created", 201);
});
