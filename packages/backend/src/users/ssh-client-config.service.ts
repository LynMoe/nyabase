import { Injectable } from '@nestjs/common';
import {
  formatSshClientConfig,
  formatSshKnownHosts,
  type SshClientConfigDto,
} from '@nyabase/common';
import { SshHostCaService } from '../ssh-host-ca/ssh-host-ca.service.js';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { SshProxySnapshotService } from '../ssh/ssh-proxy-snapshot.service.js';

/** The one-time ssh_config and known_hosts lines that reach all of a user's containers by name. */
@Injectable()
export class SshClientConfigService {
  constructor(
    private readonly hostCa: SshHostCaService,
    private readonly identities: SshIdentityService,
    private readonly snapshots: SshProxySnapshotService,
  ) {}

  async forUser(user: { id: string; username: string }): Promise<SshClientConfigDto> {
    const hostSuffix = this.snapshots.hostSuffix();
    const endpoint = this.snapshots.endpoint();
    const hostCertificateAuthority = await this.hostCa.publicKey(user.id);
    if (!endpoint) {
      return { hostSuffix, proxy: null, hostCertificateAuthority, sshConfig: null, knownHosts: null };
    }
    const { publicKey } = await this.identities.getProxyHostKeySummary();
    return {
      hostSuffix,
      proxy: { ...endpoint, hostKey: publicKey },
      hostCertificateAuthority,
      sshConfig: formatSshClientConfig({ username: user.username, ...endpoint, hostSuffix }),
      knownHosts: formatSshKnownHosts({
        ...endpoint,
        hostSuffix,
        proxyHostKey: publicKey,
        hostCertificateAuthority,
      }),
    };
  }
}
