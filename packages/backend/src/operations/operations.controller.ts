import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { OperationsService } from './operations.service.js';

@Controller('operations')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class OperationsController {
  constructor(private operationsService: OperationsService) {}

  @Get(':operationId')
  async get(
    @Param('operationId') operationId: string,
    @CurrentUser() user: UserEntity,
  ) {
    return this.operationsService.getOperationForUser(user.id, operationId);
  }
}
