import { Injectable } from '@nestjs/common';
import { formatSshKnownHosts, type SshClientConfigDto } from '@nyabase/common';
import { SshHostCaService } from '../ssh-host-ca/ssh-host-ca.service.js';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { SshProxyLinesService } from '../ssh/ssh-proxy-lines.service.js';
import { SshProxySnapshotService } from '../ssh/ssh-proxy-snapshot.service.js';

/** The proxy's lines and the known_hosts lines that reach all of a user's containers by name. */
@Injectable()
export class SshClientConfigService {
  constructor(
    private readonly hostCa: SshHostCaService,
    private readonly identities: SshIdentityService,
    private readonly lines: SshProxyLinesService,
    private readonly snapshots: SshProxySnapshotService,
  ) {}

  async forUser(user: { id: string }): Promise<SshClientConfigDto> {
    const hostSuffix = this.snapshots.hostSuffix();
    const [lines, hostCertificateAuthority, { publicKey }] = await Promise.all([
      this.lines.list(),
      this.hostCa.publicKey(user.id),
      this.identities.getProxyHostKeySummary(),
    ]);
    return {
      hostSuffix,
      lines,
      proxyHostKey: publicKey,
      hostCertificateAuthority,
      knownHosts: lines.length === 0
        ? null
        : formatSshKnownHosts({ endpoints: lines, hostSuffix, proxyHostKey: publicKey, hostCertificateAuthority }),
    };
  }
}
