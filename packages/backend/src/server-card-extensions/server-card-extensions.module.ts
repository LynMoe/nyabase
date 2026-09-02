import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
  CORE_LABEL_VALIDATORS,
  mergeNodeMetricCatalog,
  NODE_METRIC_DEFINITIONS,
  type NodeMetricCatalog,
  type NodeMetricDefinition,
} from '@nyabase/common';
import { ExtensionDeviceClaimsRepository } from './claims.repository.js';
import { assertNoPrefixCollision } from './ownership.js';
import { ServerCardExtensionRegistry } from './registry.js';
import { NODE_METRIC_CATALOG, SERVER_CARD_EXTENSIONS, type ServerCardExtension } from './types.js';

function coreMetricCatalog(): NodeMetricCatalog {
  const definitions: Record<string, NodeMetricDefinition> = {};
  for (const [name, definition] of Object.entries(NODE_METRIC_DEFINITIONS)) {
    definitions[name] = definition;
  }
  return { definitions, validators: CORE_LABEL_VALIDATORS };
}

@Global()
@Module({})
export class ServerCardExtensionsModule {
  static register(extensions: readonly ServerCardExtension[]): DynamicModule {
    assertNoPrefixCollision(extensions);
    const catalog = mergeNodeMetricCatalog(
      coreMetricCatalog(),
      ...extensions.flatMap((ext) => (ext.metricCatalog ? [ext.metricCatalog] : [])),
    );
    return {
      module: ServerCardExtensionsModule,
      global: true,
      providers: [
        { provide: SERVER_CARD_EXTENSIONS, useValue: extensions },
        { provide: NODE_METRIC_CATALOG, useValue: catalog },
        ServerCardExtensionRegistry,
        ExtensionDeviceClaimsRepository,
      ],
      exports: [
        SERVER_CARD_EXTENSIONS,
        NODE_METRIC_CATALOG,
        ServerCardExtensionRegistry,
        ExtensionDeviceClaimsRepository,
      ],
    };
  }
}
