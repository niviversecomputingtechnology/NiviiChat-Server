import { ZodError, ZodType, ZodTypeDef } from "zod";
import { ApiError } from "./errors";

// ZodType<T, ZodTypeDef, any> (rather than ZodSchema<T>, which pins input=T
// too) is required so schemas that transform/coerce — where the parsed
// input shape differs from the output shape, e.g. query strings coerced to
// numbers/booleans — still type-check when passed in here.
export function validate<T>(schema: ZodType<T, ZodTypeDef, any>, data: unknown): T {
  const result = schema.safeParse(data);
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
