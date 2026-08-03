import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { validate } from "../lib/validation";
import { sendSuccess } from "../lib/response";
import { prisma } from "../lib/prisma";
import {
  hashPassword,
  comparePassword,
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken
} from "../lib/auth";
import { toPublicUser } from "../lib/serializers";
import { ApiError, AuthError, ConflictError } from "../lib/errors";

const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.]+$/),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80),
  avatarUrl: z.string().url().optional(),
  deviceUniqueId: z.string().optional()
});

const loginSchema = z.object({
  identifier: z.string().min(1), // email or username
  password: z.string().min(1),
  deviceUniqueId: z.string().optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1)
});

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/auth/register
  fastify.post("/register", async (request, reply) => {
    const body = validate(registerSchema, request.body);

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

    return sendSuccess(
      reply,
      { accessToken, refreshToken, user: toPublicUser(user) },
      "Account created",
      201
    );
  });

  // POST /api/auth/login
  fastify.post("/login", async (request, reply) => {
    const body = validate(loginSchema, request.body);

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

    return sendSuccess(reply, { accessToken, refreshToken, user: toPublicUser(updated) }, "Logged in");
  });

  // POST /api/auth/refresh-token
  fastify.post("/refresh-token", async (request, reply) => {
    const body = validate(refreshSchema, request.body);

    const rotated = await rotateRefreshToken(body.refreshToken);
    if (!rotated) {
      throw new AuthError("Invalid, expired, or revoked refresh token");
    }

    const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
    if (!user) {
      throw new AuthError("User no longer exists");
    }

    const accessToken = signAccessToken({ sub: user.id, username: user.username });

    return sendSuccess(reply, { accessToken, refreshToken: rotated.refreshToken }, "Access token refreshed");
  });

  // POST /api/auth/logout
  fastify.post("/logout", { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = validate(logoutSchema, request.body);
    await revokeRefreshToken(body.refreshToken);
    return sendSuccess(reply, null, "Logged out");
  });
};

export default authRoutes;
