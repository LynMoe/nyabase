import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
  CORE_NODE_METRIC_CATALOG,
  mergeNodeMetricCatalog,
} from '@nyabase/common';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ExtensionDeviceClaimsRepository } from './claims.repository.js';
import { assertNoPrefixCollision } from './ownership.js';
import { ServerCardExtensionRegistry } from './registry.js';
import {
  AdminServerExtensionsController,
  UserServerExtensionsController,
} from './server-extensions.controller.js';
import { ServerCardExtensionsService } from './server-extensions.service.js';
import { NODE_METRIC_CATALOG, SERVER_CARD_EXTENSIONS, type ServerCardExtension } from './types.js';

@Global()
@Module({})
export class ServerCardExtensionsModule {
  static register(extensions: readonly ServerCardExtension[]): DynamicModule {
    assertNoPrefixCollision(extensions);
    const catalog = mergeNodeMetricCatalog(
      CORE_NODE_METRIC_CATALOG,
      ...extensions.flatMap((ext) => (ext.metricCatalog ? [ext.metricCatalog] : [])),
    );
    return {
      module: ServerCardExtensionsModule,
      global: true,
      imports: [AuthModule, AccessModule, AuditModule],
      controllers: [AdminServerExtensionsController, UserServerExtensionsController],
      providers: [
        { provide: SERVER_CARD_EXTENSIONS, useValue: extensions },
        { provide: NODE_METRIC_CATALOG, useValue: catalog },
        ServerCardExtensionRegistry,
        ExtensionDeviceClaimsRepository,
        ServerCardExtensionsService,
      ],
      exports: [
        SERVER_CARD_EXTENSIONS,
        NODE_METRIC_CATALOG,
        ServerCardExtensionRegistry,
        ExtensionDeviceClaimsRepository,
        ServerCardExtensionsService,
      ],
    };
  }
}
