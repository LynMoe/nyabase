import {
  Controller, Get, Post, Patch, Delete, Param,
  Body, UseGuards, Query, Sse, MessageEvent, HttpCode,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ImagesService } from './images.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { Capability, zCreateImageRequest, zPullImageRequest, zUpdateImageRequest } from '@nyabase/common';

@Controller('admin/images')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminImagesController {
  constructor(
    private imagesService: ImagesService,
    private agentGateway: AgentGateway,
  ) {}

  @Get()
  @RequireCaps(Capability.ManageImages)
  async list(@Query('activeOnly') activeOnly?: string) {
    return this.imagesService.findAll(activeOnly === 'true');
  }

  @Post()
  @RequireCaps(Capability.ManageImages)
  async create(@Body() body: unknown) {
    const dto = zCreateImageRequest.parse(body);
    return this.imagesService.create(dto);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageImages)
  async get(@Param('id') id: string) {
    return this.imagesService.findById(id);
  }

  @Get(':id/status')
  @RequireCaps(Capability.ManageImages)
  async getStatus(@Param('id') id: string) {
    const img = await this.imagesService.findById(id);
    return this.imagesService.getServerStatuses(img);
  }

  @Post(':id/pull')
  @RequireCaps(Capability.ManageImages)
  async pull(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = zPullImageRequest.parse(body);
    const img = await this.imagesService.findById(id);
    return this.imagesService.pullOnServers(img, dto.serverIds);
  }

  @Sse(':id/pull-progress')
  @RequireCaps(Capability.ManageImages)
  pullProgressStream(@Param('id') id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let completed = false;

      const complete = () => {
        if (completed) return;
        completed = true;
        clearInterval(hb);
        clearTimeout(autoClose);
        offProgress();
        sub.complete();
      };

      this.imagesService.findById(id)
        .then((image) => this.imagesService.getServerStatuses(image))
        .then((statuses) => { if (!completed) sub.next({ data: JSON.stringify(statuses) } as MessageEvent); })
        .catch(() => {});

      const offProgress = this.agentGateway.onPullProgress((pp) => {
        if (pp.imageId !== id) return;
        this.imagesService.findById(id)
          .then((image) => this.imagesService.getServerStatuses(image))
          .then((statuses) => { if (!completed) sub.next({ data: JSON.stringify(statuses) } as MessageEvent); })
          .catch(() => {});
        if (pp.status !== 'pulling') setTimeout(complete, 2000);
      });

      const hb = setInterval(() => {
        if (!completed) sub.next({ data: JSON.stringify({ heartbeat: true }) } as MessageEvent);
      }, 5000);

      const autoClose = setTimeout(complete, 600_000);

      return complete;
    });
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageImages)
  async update(@Param('id') id: string, @Body() body: unknown) {
    const dto = zUpdateImageRequest.parse(body);
    return this.imagesService.update(id, dto);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageImages)
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.imagesService.delete(id);
  }
}
