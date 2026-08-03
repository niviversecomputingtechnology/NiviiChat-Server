import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken, type AccessTokenPayload } from "./auth";
import { AuthError, ApiError } from "./errors";
import { buildError } from "./response";

export function getTraceId(req: NextRequest): string {
  return req.headers.get("x-trace-id") ?? randomUUID();
}

export function logRequest(req: NextRequest, traceId: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "info",
      trace_id: traceId,
      method: req.method,
      path: req.nextUrl.pathname,
      time_zone: req.headers.get("time-zone"),
      ts: new Date().toISOString(),
      ...extra
    })
  );
}

export function logError(traceId: string, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      trace_id: traceId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ts: new Date().toISOString()
    })
  );
}

export function requireAuth(req: NextRequest): AccessTokenPayload {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    throw new AuthError("Missing bearer access token");
  }

  try {
    return verifyAccessToken(token);
  } catch {
    throw new AuthError("Invalid or expired access token");
  }
}

type RouteContext = { params: Record<string, string> };
type AuthedHandler = (
  req: NextRequest,
  ctx: RouteContext,
  auth: AccessTokenPayload,
  traceId: string
) => Promise<NextResponse>;
type PublicHandler = (req: NextRequest, ctx: RouteContext, traceId: string) => Promise<NextResponse>;

/** Wraps a route handler that requires a valid access token. */
export function withAuth(handler: AuthedHandler) {
  return async (req: NextRequest, ctx: RouteContext): Promise<NextResponse> => {
    const traceId = getTraceId(req);
    logRequest(req, traceId);
    try {
      const auth = requireAuth(req);
      return await handler(req, ctx, auth, traceId);
    } catch (err) {
      return handleRouteError(err, traceId);
    }
  };
}

/** Wraps a route handler that does not require auth (register/login/refresh). */
export function withPublic(handler: PublicHandler) {
  return async (req: NextRequest, ctx: RouteContext): Promise<NextResponse> => {
    const traceId = getTraceId(req);
    logRequest(req, traceId);
    try {
      return await handler(req, ctx, traceId);
    } catch (err) {
      return handleRouteError(err, traceId);
    }
  };
}

function handleRouteError(err: unknown, traceId: string): NextResponse {
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logError(traceId, err);
    }
    return buildError(err.message, { status: err.status, error: err.details ?? null, traceId });
  }

  logError(traceId, err);
  return buildError("Internal server error", {
    status: 500,
    error: process.env.NODE_ENV === "development" ? String(err) : null,
    traceId
  });
}
