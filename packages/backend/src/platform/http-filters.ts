import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  ConflictException,
  Logger,
  NotFoundException,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join, sep } from 'node:path';
import { DatabaseError } from 'pg';
import { ZodError } from 'zod';
import { FailureCode } from '@nyabase/common';
import { isRetryablePgTransactionError } from './persistence-pg/transaction.js';

/**
 * Converts ZodError thrown by z.parse() in controllers into a 400 response.
 * Without this filter, Zod validation failures become 500 Internal Server Error
 * because ZodError is not a NestJS HttpException.
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();

    const first = exception.issues[0];
    const field = first?.path.join('.') ?? '';
    const message = field ? `${field}: ${first.message}` : (first?.message ?? 'Invalid request parameters');

    response.status(400).json({
      statusCode: 400,
      code: 'INVALID_INPUT',
      message,
      details: {
        issues: exception.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
}

/**
 * A serialization failure (40001) or deadlock (40P01) that outlasted the
 * transaction's own retries lost to concurrent writes; nothing is wrong with
 * the server or the request. It answers 409 TRANSACTION_CONFLICT, which the
 * client may simply send again, instead of a 500. Any other database error
 * keeps Nest's default handling (500, logged). Construct it with the HTTP
 * adapter (`app.getHttpAdapter()`), which the default handling replies through.
 */
@Catch(DatabaseError)
export class PgTransactionConflictFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PgTransactionConflictFilter.name);

  catch(exception: DatabaseError, host: ArgumentsHost): void {
    if (!isRetryablePgTransactionError(exception)) {
      super.catch(exception, host);
      return;
    }
    this.logger.warn(`Request lost to concurrent writes (sqlstate=${exception.code}); answered 409`);
    super.catch(new ConflictException({
      code: FailureCode.TransactionConflict,
      message: '与其他同时进行的修改冲突，请重试',
    }), host);
  }
}

/** Vite content-hashes everything under /assets/, so a URL there never changes meaning. */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** index.html names the current hashed chunks; browsers must revalidate it on every load. */
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

/**
 * Paths that name a file rather than a client-side route: everything under
 * /assets/ and any path whose last segment has a file extension (SPA routes
 * never do; their parameters are UUIDs).
 */
export function isStaticFilePath(path: string): boolean {
  return path.startsWith('/assets/') || /\/[^/]*\.[A-Za-z0-9]+$/.test(path);
}

/** serve-static options for the bundled frontend directory. */
function frontendStaticOptions(publicDir: string) {
  const assetsDir = join(publicDir, 'assets') + sep;
  return {
    setHeaders(response: { setHeader(name: string, value: string): void }, filePath: string) {
      response.setHeader(
        'Cache-Control',
        filePath.startsWith(assetsDir) ? IMMUTABLE_ASSET_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
      );
    },
  };
}

/**
 * Intercepts NestJS 404 (NotFoundException) responses:
 * - API paths (/api/*) → standard JSON 404
 * - static file paths (/assets/*, anything with an extension) → plain 404.
 *   After a redeploy replaces the hashed chunks, an open tab importing an old
 *   one must see the failure (and reload) instead of parsing index.html as JS.
 * - other GET/HEAD paths → the SPA index.html for client-side routing
 */
@Catch(NotFoundException)
export class SpaFallbackFilter implements ExceptionFilter {
  constructor(private readonly indexPath: string) {}

  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    // NestJS 12 mounts its router under the global prefix, so `path` is relative to it.
    const request = ctx.getRequest<{ originalUrl: string; method: string }>();
    // Use any for the response to avoid requiring @types/express as a prod dep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = ctx.getResponse<any>();
    answerNotFound(request.originalUrl.split('?')[0]!, request.method, response, this.indexPath, exception.message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function answerNotFound(path: string, method: string, response: any, indexPath: string, message: string): void {
  if (path === '/api' || path.startsWith('/api/')) {
    response.status(404).json({
      statusCode: 404,
      message,
      error: 'Not Found',
    });
  } else if (isStaticFilePath(path) || (method !== 'GET' && method !== 'HEAD')) {
    response.status(404).type('text/plain').send('Not Found');
  } else {
    response.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
    response.sendFile(indexPath);
  }
}

/**
 * Serve the bundled frontend from `publicDir` with long-lived caching for the
 * hashed assets and the SPA fallback for client-side routes. Middleware
 * registered before this (security headers) still applies to every response.
 * Paths outside the API never reach the Nest router (it is mounted under the
 * global prefix), so the fallback for them is a middleware after the assets.
 */
export function serveBundledFrontend(app: NestExpressApplication, publicDir: string): void {
  const indexPath = join(publicDir, 'index.html');
  app.useStaticAssets(publicDir, frontendStaticOptions(publicDir));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((request: any, response: any, next: () => void) => {
    const path = String(request.originalUrl ?? request.url).split('?')[0]!;
    if (path === '/api' || path.startsWith('/api/')) {
      next();
      return;
    }
    answerNotFound(path, request.method, response, indexPath, 'Not Found');
  });
  app.useGlobalFilters(new SpaFallbackFilter(indexPath));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every route path parameter names a resource by UUID. A malformed one cannot
 * name anything, so it is a 404 here instead of a PostgreSQL cast error (500).
 */
export class RouteIdPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'param' || typeof value !== 'string' || UUID.test(value)) return value;
    throw new NotFoundException(`No resource has the id ${JSON.stringify(value.slice(0, 64))}`);
  }
}
