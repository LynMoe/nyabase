import { Inject, Injectable } from '@nestjs/common';
import type { ExtensionErrorFormatter, NodeMetricCatalog } from '@nyabase/common';
import {
  CORE_MANAGED_FIELD_OWNERSHIP,
  type ManagedFieldOwnership,
  type ManagedFieldsDiff,
} from '../incus/compare-managed-fields.js';
import { NODE_METRIC_CATALOG, SERVER_CARD_EXTENSIONS, type ServerCardExtension } from './types.js';

@Injectable()
export class ServerCardExtensionRegistry {
  constructor(
    @Inject(SERVER_CARD_EXTENSIONS)
    private readonly extensions: readonly ServerCardExtension[],
    @Inject(NODE_METRIC_CATALOG)
    private readonly catalog: NodeMetricCatalog,
  ) {}

  get(id: string): ServerCardExtension | undefined {
    return this.extensions.find((ext) => ext.id === id);
  }

  all(): readonly ServerCardExtension[] {
    return this.extensions;
  }

  managedFieldOwnership(): ManagedFieldOwnership {
    return {
      configPrefixes: [
        ...CORE_MANAGED_FIELD_OWNERSHIP.configPrefixes,
        ...this.extensions.flatMap((ext) => ext.ownedIncusConfigKeyPrefixes),
      ],
      deviceNames: CORE_MANAGED_FIELD_OWNERSHIP.deviceNames,
      devicePrefixes: [
        ...CORE_MANAGED_FIELD_OWNERSHIP.devicePrefixes,
        ...this.extensions.flatMap((ext) => ext.ownedIncusDeviceNamePrefixes),
      ],
    };
  }

  requiresStop(diff: ManagedFieldsDiff): boolean {
    return this.extensions.some((ext) => ext.requiresStop(diff));
  }

  errorFormatters(): ExtensionErrorFormatter[] {
    return this.extensions.map((ext) => ext.errorFormatter);
  }

  metricCatalog(): NodeMetricCatalog {
    return this.catalog;
  }
}
