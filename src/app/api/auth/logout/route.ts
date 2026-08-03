import { z } from "zod";
import { withAuth } from "@/lib/middleware";
import { parseJsonBody } from "@/lib/validation";
import { buildSuccess } from "@/lib/response";
import { revokeRefreshToken } from "@/lib/auth";

const logoutSchema = z.object({
  refreshToken: z.string().min(1)
});

export const POST = withAuth(async (req, _ctx, _auth, _traceId) => {
  const body = await parseJsonBody(req, logoutSchema);
  await revokeRefreshToken(body.refreshToken);
  return buildSuccess(null, "Logged out");
});
