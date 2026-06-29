import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  type SshProxyEndpoint,
  type SshProxySnapshot,
} from '@nyabase/common';
import { ContainerEntity } from '../entities/container.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ContainerSshRouteService } from './container-ssh-route.service.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

@Injectable()
export class SshProxySnapshotService {
  private generation = 0;

  constructor(
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(SshPublicKeyEntity)
    private userPublicKeysRepo: Repository<SshPublicKeyEntity>,
    @InjectRepository(UserInternalSshKeyEntity)
    private userInternalKeysRepo: Repository<UserInternalSshKeyEntity>,
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    @InjectRepository(ImageEntity)
    private imagesRepo: Repository<ImageEntity>,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    private routes: ContainerSshRouteService,
    private identities: SshIdentityService,
    private config: NyabaseConfigService,
  ) {}

  bumpGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  async buildSnapshot(): Promise<SshProxySnapshot> {
    const generation = this.bumpGeneration();
    const [users, publicKeys, internalKeys, servers, images, containers, routes, hostKey] = await Promise.all([
      this.usersRepo.find(),
      this.userPublicKeysRepo.find(),
      this.userInternalKeysRepo.find(),
      this.serversRepo.find(),
      this.imagesRepo.find(),
      this.containersRepo.find(),
      this.routes.snapshotRows(),
      this.identities.ensureProxyHostKey(),
    ]);
    const publicKeysByUser = new Map<string, string[]>();
    for (const key of publicKeys) {
      const list = publicKeysByUser.get(key.userId) ?? [];
      list.push(key.keyText);
      publicKeysByUser.set(key.userId, list);
    }
    const internalByUser = new Map(internalKeys.map((key) => [key.userId, key]));

    const userRows = [];
    for (const user of users) {
      const key = internalByUser.get(user.id) ?? await this.identities.ensureUserKey(user.id);
      userRows.push({
        id: user.id,
        username: user.username,
        status: user.status,
        publicKeys: publicKeysByUser.get(user.id) ?? [],
        internalPrivateKey: this.identities.decryptUserPrivateKey(key),
        internalPublicKey: key.publicKey,
        internalKeyFingerprint: key.fingerprint,
        internalKeyGeneration: key.generation,
      });
    }

    return {
      generation,
      createdAt: new Date().toISOString(),
      staleAfterMs: this.config.get<number>('ssh.proxySnapshotStaleMs'),
      endpoint: this.endpoint(),
      hostKey: {
        privateKey: hostKey.privateKey,
        publicKey: hostKey.publicKey,
        fingerprint: hostKey.fingerprint,
        generation: hostKey.generation,
      },
      users: userRows,
      servers: servers.map((server) => ({
        id: server.id,
        slug: server.slug,
        name: server.name,
      })),
      images: images.map((image) => ({
        id: image.id,
        disableSsh: image.disableSsh,
      })),
      containers: containers.map((container) => ({
        id: container.id,
        ownerId: container.ownerId,
        serverId: container.serverId,
        imageId: container.imageId,
        name: container.name,
        deleted: Boolean(container.deletedAt),
      })),
      routes,
    };
  }

  endpoint(): SshProxyEndpoint | null {
    const host = this.config.get<string>('ssh.proxyPublicHost')?.trim();
    const port = this.config.get<number>('ssh.proxyPublicPort');
    return host && port ? { host, port } : null;
  }
}
