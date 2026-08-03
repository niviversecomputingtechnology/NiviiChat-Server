import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseQuery } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { toPublicUser } from "@/lib/serializers";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

// GET /api/users?query= — search users for the Add Chat screen.
export const GET = withAuth(async (req, _ctx, auth) => {
  const { query, limit } = parseQuery(req, searchSchema);

  const users = await prisma.user.findMany({
    where: {
      id: { not: auth.sub },
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

  return buildSuccess(users.map(toPublicUser));
});
