import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody, parseQuery } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { CALL_INCLUDE, toCallDTO } from "@/lib/serializers";
import { NotFoundError } from "@/lib/errors";

const logCallSchema = z.object({
  chatId: z.string().min(1),
  type: z.enum(["VOICE", "VIDEO"]),
  status: z.enum(["MISSED", "COMPLETED", "DECLINED"]),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  duration: z.number().int().min(0).optional()
});

// POST /api/calls — log a completed/missed/declined call.
export const POST = withAuth(async (req, _ctx, auth) => {
  const body = await parseJsonBody(req, logCallSchema);

  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_userId: { chatId: body.chatId, userId: auth.sub } }
  });
  if (!participant) {
    throw new NotFoundError("Chat not found");
  }

  const call = await prisma.call.create({
    data: {
      chatId: body.chatId,
      initiatorId: auth.sub,
      type: body.type,
      status: body.status,
      startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
      endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
      duration: body.duration
    },
    include: CALL_INCLUDE
  });

  return buildSuccess(toCallDTO(call), "Call logged", 201);
});

const callsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

// GET /api/calls — call history across all of the current user's chats.
export const GET = withAuth(async (req, _ctx, auth) => {
  const { cursor, limit } = parseQuery(req, callsQuerySchema);

  const page = await prisma.call.findMany({
    where: { chat: { participants: { some: { userId: auth.sub } } } },
    orderBy: { startedAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: CALL_INCLUDE
  });

  let nextCursor: string | null = null;
  if (page.length > limit) {
    nextCursor = page.pop()!.id;
  }

  return buildSuccess({ calls: page.map(toCallDTO), nextCursor });
});
