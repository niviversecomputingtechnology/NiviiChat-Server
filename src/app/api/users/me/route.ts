import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { toPublicUser } from "@/lib/serializers";
import { NotFoundError } from "@/lib/errors";

export const GET = withAuth(async (_req, _ctx, auth) => {
  const user = await prisma.user.findUnique({ where: { id: auth.sub } });
  if (!user) throw new NotFoundError("User not found");
  return buildSuccess(toPublicUser(user));
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  bio: z.string().max(280).nullable().optional()
});

export const PATCH = withAuth(async (req, _ctx, auth) => {
  const body = await parseJsonBody(req, updateSchema);

  const user = await prisma.user.update({
    where: { id: auth.sub },
    data: body
  });

  return buildSuccess(toPublicUser(user), "Profile updated");
});
