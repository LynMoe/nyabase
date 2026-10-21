import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  NotFoundException,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { ZodError } from 'zod';

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

    const first = exception.errors[0];
    const field = first?.path.join('.') ?? '';
    const message = field ? `${field}: ${first.message}` : (first?.message ?? 'Invalid request parameters');

    response.status(400).json({
      statusCode: 400,
      code: 'INVALID_INPUT',
      message,
      details: {
        issues: exception.errors.map((issue) => ({
          path: issue.path,
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
}

/**
 * Intercepts NestJS 404 (NotFoundException) responses:
 * - API paths (/api/*) → standard JSON 404
 * - All other paths → serve the SPA index.html for client-side routing
 */
@Catch(NotFoundException)
export class SpaFallbackFilter implements ExceptionFilter {
  constructor(private readonly indexPath: string) {}

  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ path: string }>();
    // Use any for the response to avoid requiring @types/express as a prod dep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = ctx.getResponse<any>();

    if (request.path.startsWith('/api')) {
      response.status(404).json({
        statusCode: 404,
        message: exception.message,
        error: 'Not Found',
      });
    } else {
      response.sendFile(this.indexPath);
    }
  }
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
