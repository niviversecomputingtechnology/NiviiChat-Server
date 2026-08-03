import { z } from "zod";
import { withPublic } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { comparePassword, signAccessToken, issueRefreshToken } from "@/lib/auth";
import { toPublicUser } from "@/lib/serializers";
import { ApiError } from "@/lib/errors";

const loginSchema = z.object({
  identifier: z.string().min(1), // email or username
  password: z.string().min(1),
  deviceUniqueId: z.string().optional()
});

export const POST = withPublic(async (req, _ctx, _traceId) => {
  const body = await parseJsonBody(req, loginSchema);

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: body.identifier }, { username: body.identifier }] }
  });

  if (!user || !(await comparePassword(body.password, user.passwordHash))) {
    throw new ApiError("Invalid credentials", 401);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      isOnline: true,
      lastSeenAt: new Date(),
      ...(body.deviceUniqueId ? { deviceUniqueId: body.deviceUniqueId } : {})
    }
  });

  const accessToken = signAccessToken({ sub: updated.id, username: updated.username });
  const refreshToken = await issueRefreshToken(updated.id);

  return buildSuccess({ accessToken, refreshToken, user: toPublicUser(updated) }, "Logged in");
});
