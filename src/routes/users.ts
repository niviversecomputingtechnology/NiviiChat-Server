import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { validate } from "../lib/validation";
import { sendSuccess } from "../lib/response";
import { prisma } from "../lib/prisma";
import { toPublicUser } from "../lib/serializers";
import { NotFoundError } from "../lib/errors";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const updateMeSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  bio: z.string().max(280).nullable().optional()
});

const userRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // GET /api/users?query= — search users for the Add Chat screen.
  fastify.get("/", async (request, reply) => {
    const { query, limit } = validate(searchSchema, request.query);

    const users = await prisma.user.findMany({
      where: {
        id: { not: request.user.sub },
        ...(query
          ? {
              OR: [
                { username: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
                { email: { contains: query, mode: "insensitive" } }
              ]
            }
          : {})
      },
      take: limit,
      orderBy: { username: "asc" }
    });

    return sendSuccess(reply, users.map(toPublicUser));
  });

  // GET /api/users/me
  fastify.get("/me", async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user) throw new NotFoundError("User not found");
    return sendSuccess(reply, toPublicUser(user));
  });

  // PATCH /api/users/me
  fastify.patch("/me", async (request, reply) => {
    const body = validate(updateMeSchema, request.body);
    const user = await prisma.user.update({ where: { id: request.user.sub }, data: body });
    return sendSuccess(reply, toPublicUser(user), "Profile updated");
  });

  // GET /api/users/[id] — public profile lookup (e.g. tapping a participant in a chat).
  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!user) throw new NotFoundError("User not found");
    return sendSuccess(reply, toPublicUser(user));
  });
};

export default userRoutes;
