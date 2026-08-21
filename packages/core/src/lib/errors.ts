/** Domain failure with an HTTP-ish status so both transports can map it. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, "bad_request", message, details);

export const notFound = (what: string, id?: string) =>
  new AppError(404, "not_found", id ? `${what} '${id}' does not exist` : `${what} does not exist`, { id });

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(409, "conflict", message, details);
