import { z } from "zod";
import { withPublic } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { hashPassword, signAccessToken, issueRefreshToken } from "@/lib/auth";
import { toPublicUser } from "@/lib/serializers";
import { ConflictError } from "@/lib/errors";

const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.]+$/),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80),
  avatarUrl: z.string().url().optional(),
  deviceUniqueId: z.string().optional()
});

export const POST = withPublic(async (req, _ctx, _traceId) => {
  const body = await parseJsonBody(req, registerSchema);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: body.email }, { username: body.username }] }
  });
  if (existing) {
    throw new ConflictError(
      existing.email === body.email ? "Email is already registered" : "Username is already taken"
    );
  }

  const passwordHash = await hashPassword(body.password);
  const user = await prisma.user.create({
    data: {
      username: body.username,
      email: body.email,
      passwordHash,
      name: body.name,
      avatarUrl: body.avatarUrl,
      deviceUniqueId: body.deviceUniqueId
    }
  });

  const accessToken = signAccessToken({ sub: user.id, username: user.username });
  const refreshToken = await issueRefreshToken(user.id);

  return buildSuccess(
    { accessToken, refreshToken, user: toPublicUser(user) },
    "Account created",
    201
  );
});
