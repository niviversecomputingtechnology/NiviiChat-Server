export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 400, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class AuthError extends ApiError {
  constructor(message = "Missing or invalid access token") {
    super(message, 401);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(message, 404);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict") {
    super(message, 409);
  }
}
