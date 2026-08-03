import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../lib/errors";
import { sendError } from "../lib/response";

/**
 * Central envelope mapping: every thrown error (ApiError from a route,
 * Fastify's own body/multipart parsing errors, or anything unexpected)
 * lands here and comes out as { status:false, message, error, trace_id }.
 * request.id is used as trace_id — see genReqId in server.ts.
 */
const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status >= 500) {
        request.log.error(error);
      }
      return sendError(reply, error.message, {
        status: error.status,
        error: error.details ?? null,
        traceId: request.id
      });
    }

    // Fastify/plugin errors (bad JSON body, file-too-large from
    // @fastify/multipart, etc.) carry a statusCode; anything without one,
    // or >=500, is treated as unexpected and logged.
    const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error(error);
    }

    return sendError(reply, status < 500 ? error.message : "Internal server error", {
      status,
      error: status >= 500 && process.env.NODE_ENV === "development" ? error.message : null,
      traceId: request.id
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    return sendError(reply, "Route not found", { status: 404, traceId: request.id });
  });
};

export default fp(errorHandlerPlugin);
