import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { verifyAccessToken, type AccessTokenPayload } from "../lib/auth";
import { AuthError } from "../lib/errors";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    user: AccessTokenPayload;
  }
}

/**
 * Route-level guard: add `{ preHandler: fastify.authenticate }` to any
 * route that requires a valid access token. Throws AuthError (-> 401, never
 * 403, per the client's logout-on-401 contract) rather than replying
 * directly, so the central error handler renders it in the standard
 * envelope.
 */
const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("authenticate", async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

    if (!token) {
      throw new AuthError("Missing bearer access token");
    }

    try {
      request.user = verifyAccessToken(token);
    } catch {
      throw new AuthError("Invalid or expired access token");
    }
  });
};

export default fp(authPlugin);
