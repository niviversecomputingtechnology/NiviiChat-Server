import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { validate } from "../lib/validation";
import { sendSuccess } from "../lib/response";
import { prisma } from "../lib/prisma";
import { CALL_INCLUDE, toCallDTO } from "../lib/serializers";
import { NotFoundError } from "../lib/errors";

const logCallSchema = z.object({
  chatId: z.string().min(1),
  type: z.enum(["VOICE", "VIDEO"]),
  status: z.enum(["MISSED", "COMPLETED", "DECLINED"]),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  duration: z.number().int().min(0).optional()
});

const callsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const callRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // POST /api/calls — log a completed/missed/declined call.
  fastify.post("/", async (request, reply) => {
    const body = validate(logCallSchema, request.body);
    const currentUserId = request.user.sub;

    const participant = await prisma.chatParticipant.findUnique({
      where: { chatId_userId: { chatId: body.chatId, userId: currentUserId } }
    });
    if (!participant) {
      throw new NotFoundError("Chat not found");
    }

    const call = await prisma.call.create({
      data: {
        chatId: body.chatId,
        initiatorId: currentUserId,
        type: body.type,
        status: body.status,
        startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
        endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
        duration: body.duration
      },
      include: CALL_INCLUDE
    });

    return sendSuccess(reply, toCallDTO(call), "Call logged", 201);
  });

  // GET /api/calls — call history across all of the current user's chats.
  fastify.get("/", async (request, reply) => {
    const { cursor, limit } = validate(callsQuerySchema, request.query);

    const page = await prisma.call.findMany({
      where: { chat: { participants: { some: { userId: request.user.sub } } } },
      orderBy: { startedAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: CALL_INCLUDE
    });

    let nextCursor: string | null = null;
    if (page.length > limit) {
      nextCursor = page.pop()!.id;
    }

    return sendSuccess(reply, { calls: page.map(toCallDTO), nextCursor });
  });
};

export default callRoutes;
