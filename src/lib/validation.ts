import { NextRequest } from "next/server";
import { ZodSchema, ZodError } from "zod";
import { ApiError } from "./errors";

export async function parseJsonBody<T>(req: NextRequest, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError("Request body must be valid JSON", 400);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError("Validation failed", 422, formatZodError(result.error));
  }
  return result.data;
}

export function parseQuery<T>(req: NextRequest, schema: ZodSchema<T>): T {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ApiError("Validation failed", 422, formatZodError(result.error));
  }
  return result.data;
}

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));
}
