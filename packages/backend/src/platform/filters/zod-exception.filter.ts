import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
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
