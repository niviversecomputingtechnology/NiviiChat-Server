import type { FastifyReply } from "fastify";

const APP_VERSION = process.env.APP_VERSION ?? "0.0.0";

export interface SuccessBody<T> {
  status: true;
  message: string;
  data: T;
  app_version: string;
}

export interface ErrorBody {
  status: false;
  message: string;
  error: unknown;
  trace_id?: string;
}

export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  message = "OK",
  statusCode = 200
): FastifyReply {
  const body: SuccessBody<T> = { status: true, message, data, app_version: APP_VERSION };
  return reply.code(statusCode).send(body);
}

export function sendError(
  reply: FastifyReply,
  message: string,
  opts?: { status?: number; error?: unknown; traceId?: string }
): FastifyReply {
  const body: ErrorBody = {
    status: false,
    message,
    error: opts?.error ?? null,
    trace_id: opts?.traceId
  };
  return reply.code(opts?.status ?? 400).send(body);
}
