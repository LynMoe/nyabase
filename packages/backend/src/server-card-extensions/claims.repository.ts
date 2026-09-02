import { Injectable } from '@nestjs/common';
import type { ExtensionClaimsPort } from './types.js';

function notPersisted(): never {
  throw new Error('extension device claims are not persisted yet');
}

@Injectable()
export class ExtensionDeviceClaimsRepository {
  for(_extensionId: string, _serverId: string, _containerId: string): ExtensionClaimsPort {
    return {
      replace: async () => notPersisted(),
      listOccupiedKeys: async () => notPersisted(),
      count: async () => notPersisted(),
    };
  }
}
