import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserEntity } from '../../entities/user.entity.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserEntity => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
