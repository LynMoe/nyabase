import { Injectable } from '@nestjs/common';

@Injectable()
export class ResourceKeyService {
  container(containerId: string): string {
    return `container:${containerId}`;
  }

  dataDir(input: {
    serverId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
    userId: string;
    name: string;
  }): string {
    return `datadir:${input.serverId}:${input.sourceKind}:${input.sourceId}:${input.userId}:${input.name}`;
  }

  mountSource(input: {
    serverId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
  }): string {
    return `mount_source:${input.serverId}:${input.sourceKind}:${input.sourceId}`;
  }

  remoteFsAssignment(serverId: string, remoteFsMountId: string): string {
    return `remote_fs_assignment:${serverId}:${remoteFsMountId}`;
  }

  disk(serverId: string, diskId: string): string {
    return `disk:${serverId}:${diskId}`;
  }

  quota(serverId: string, userId: string): string {
    return `quota:${serverId}:${userId}`;
  }

  image(serverId: string, imageId: string): string {
    return `image:${serverId}:${imageId}`;
  }

  generic(serverId: string, resourceType: string, resourceId: string): string {
    switch (resourceType) {
      case 'container':
        return this.container(resourceId);
      case 'data_disk':
        return this.disk(serverId, resourceId);
      case 'remote_fs_mount':
        return this.remoteFsAssignment(serverId, resourceId);
      case 'quota':
        return this.quota(serverId, resourceId);
      case 'image':
        return this.image(serverId, resourceId);
      default:
        return `${resourceType}:${serverId}:${resourceId}`;
    }
  }
}
