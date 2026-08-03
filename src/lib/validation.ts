import { NextRequest } from "next/server";
import { ZodError, ZodType, ZodTypeDef } from "zod";
import { ApiError } from "./errors";

// ZodType<T, ZodTypeDef, any> (rather than ZodSchema<T>, which pins input=T
// too) is required so schemas that transform/coerce — where the parsed
// input shape differs from the output shape, e.g. query strings coerced to
// numbers/booleans — still type-check when passed in here.
export async function parseJsonBody<T>(req: NextRequest, schema: ZodType<T, ZodTypeDef, any>): Promise<T> {
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

export function parseQuery<T>(req: NextRequest, schema: ZodType<T, ZodTypeDef, any>): T {
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
