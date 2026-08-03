import { withAuth } from "@/lib/middleware";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { toPublicUser } from "@/lib/serializers";
import { NotFoundError } from "@/lib/errors";

// GET /api/users/[id] — public profile lookup (e.g. tapping a participant in a chat).
export const GET = withAuth(async (_req, ctx) => {
  const user = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!user) throw new NotFoundError("User not found");
  return buildSuccess(toPublicUser(user));
});
