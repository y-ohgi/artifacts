/**
 * JSON error envelope shared by every `/_app/*` API endpoint.
 *
 * See specs/001-html-artifact-hosting/contracts/http-api.md ("エラー応答(JSON)の形").
 */

/**
 * The complete set of error codes used by the HTTP API.
 *
 * Declared as a const object so that a typo in a code becomes a compile error
 * (the extracted `ErrorCode` union has no room for unknown strings).
 */
export const ErrorCodes = {
  INVALID_NAME: "invalid_name",
  NOT_HTML: "not_html",
  NAME_CONFLICT: "name_conflict",
  TOO_LARGE: "too_large",
  CROSS_ORIGIN: "cross_origin",
  STORAGE_FAILED: "storage_failed",
  INVALID_VISIBILITY: "invalid_visibility",
  NOT_FOUND: "not_found",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Code specific extra fields (e.g. `suggestions`, `allowed`, `limitBytes`). */
export type ErrorDetails = Record<string, unknown>;

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ErrorDetails;
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: ErrorDetails;
  };
}

/**
 * Wraps a payload into the `{ error: { code, message, details? } }` shape.
 * `details` is omitted from the JSON when it is not provided.
 */
export function errorEnvelope(payload: ErrorPayload): ErrorEnvelope {
  return {
    error:
      payload.details === undefined
        ? { code: payload.code, message: payload.message }
        : { code: payload.code, message: payload.message, details: payload.details },
  };
}

/**
 * Builds a JSON `Response` carrying the error envelope.
 *
 * Security headers are intentionally not baked in here: the caller passes the
 * profile it needs (see `src/headers.ts`) so that this module stays independent
 * of the header profiles.
 */
export function errorResponse(
  status: number,
  payload: ErrorPayload,
  headers?: HeadersInit,
): Response {
  const merged = new Headers(headers);
  merged.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(errorEnvelope(payload)), { status, headers: merged });
}
