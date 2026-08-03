import { NextResponse } from "next/server";

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

export function buildSuccess<T>(data: T, message = "OK", status = 200): NextResponse<SuccessBody<T>> {
  return NextResponse.json(
    { status: true, message, data, app_version: APP_VERSION },
    { status }
  );
}

export function buildError(
  message: string,
  opts?: { status?: number; error?: unknown; traceId?: string }
): NextResponse<ErrorBody> {
  return NextResponse.json(
    {
      status: false,
      message,
      error: opts?.error ?? null,
      trace_id: opts?.traceId
    },
    { status: opts?.status ?? 400 }
  );
}
