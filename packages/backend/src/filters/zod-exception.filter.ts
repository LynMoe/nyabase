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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = ctx.getResponse<any>();

    const first = exception.errors[0];
    const field = first?.path.join('.') ?? '';
    const message = field ? `${field}: ${first.message}` : (first?.message ?? 'Invalid request parameters');

    response.status(400).json({
      statusCode: 400,
      message,
    });
  }
}
