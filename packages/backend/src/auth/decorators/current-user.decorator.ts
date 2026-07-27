import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserRecord } from '../../domain/domain-records.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserRecord => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
