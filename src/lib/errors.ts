import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Every error response has the shape { error: { code, message, conflicts? } }. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly conflicts?: string[],
  ) {
    super(message);
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.conflicts ? { conflicts: this.conflicts } : {}),
      },
    };
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const invalidState = (message: string) => new AppError(409, 'invalid_state', message);
export const versionConflict = () =>
  new AppError(409, 'version_conflict', 'The resource was changed by another request; reload and retry');
export const overlapLimit = (conflicts: string[]) =>
  new AppError(409, 'overlap_limit', 'At most 2 events may overlap at any moment', conflicts);
