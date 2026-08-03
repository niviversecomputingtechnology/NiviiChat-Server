import { z } from "zod";
import { withPublic } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { prisma } from "@/lib/prisma";
import { rotateRefreshToken, signAccessToken } from "@/lib/auth";
import { AuthError } from "@/lib/errors";

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

export const POST = withPublic(async (req, _ctx, _traceId) => {
  const body = await parseJsonBody(req, refreshSchema);

  const rotated = await rotateRefreshToken(body.refreshToken);
  if (!rotated) {
    throw new AuthError("Invalid, expired, or revoked refresh token");
  }

  const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
  if (!user) {
    throw new AuthError("User no longer exists");
  }

  const accessToken = signAccessToken({ sub: user.id, username: user.username });

  return buildSuccess(
    { accessToken, refreshToken: rotated.refreshToken },
    "Access token refreshed"
  );
});
