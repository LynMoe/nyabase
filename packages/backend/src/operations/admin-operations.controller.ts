import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { OperationsService } from './operations.service.js';

@Controller('admin/operations')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageContainersAny)
export class AdminOperationsController {
  constructor(private operationsService: OperationsService) {}

  @Get(':operationId')
  async get(@Param('operationId') operationId: string) {
    return this.operationsService.getOperationForAdmin(operationId);
  }
}
