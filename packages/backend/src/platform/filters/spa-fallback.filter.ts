import { ExceptionFilter, Catch, ArgumentsHost, NotFoundException } from '@nestjs/common';

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
