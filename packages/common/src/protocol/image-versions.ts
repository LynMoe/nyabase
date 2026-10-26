import type { ContainerPowerIntent, ResourceLifecyclePhase } from '../enums.js';

/** A container still created from one image version. */
export interface ImageVersionContainerDto {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  serverId: string;
  serverName: string;
  lifecyclePhase: ResourceLifecyclePhase;
  powerIntent: ContainerPowerIntent;
}

/**
 * One fingerprint the image has been pulled at. A repull makes a new version
 * current (new containers use it) and keeps the older copies on the servers for
 * the containers created from them; a version is deletable once it is not
 * current and no container uses it.
 */
export interface ImageVersionDto {
  fingerprint: string;
  description: string | null;
  current: boolean;
  createdAt: string | null;
  containers: ImageVersionContainerDto[];
  deletable: boolean;
}
