import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { PackageHttpError } from '@nyabase/common';

@Catch(PackageHttpError)
export class PackageHttpErrorFilter implements ExceptionFilter {
  catch(exception: PackageHttpError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();

    response.status(exception.statusCode).json({
      statusCode: exception.statusCode,
      code: exception.code,
      message: exception.message,
      details: exception.details,
    });
  }
}
