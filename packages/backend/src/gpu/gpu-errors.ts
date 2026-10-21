import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';

type Details = Record<string, unknown>;

function body(code: string, message: string, details?: Details) {
  return details ? { code, message, details } : { code, message };
}

export function gpuBadRequest(code: string, message: string, details?: Details): BadRequestException {
  return new BadRequestException(body(code, message, details));
}

export function gpuForbidden(code: string, message: string, details?: Details): ForbiddenException {
  return new ForbiddenException(body(code, message, details));
}

export function gpuConflict(code: string, message: string, details?: Details): ConflictException {
  return new ConflictException(body(code, message, details));
}

/** `{ code, message, details }` body of a Nest HTTP exception, for assertions and logging. */
export function gpuErrorBody(error: unknown): { code?: string; message?: string; details?: Details } | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null ? response as never : null;
}
