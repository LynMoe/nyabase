import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  type ContainerDto,
  type CreateContainerRequest,
  type IntentAcceptedDto,
  type PutServerGrantRequest,
  type Role,
  type SshClientConfigDto,
  type SshPublicKeyDto,
  type UserDto,
} from '@nyabase/common';
import { Api, ApiError, login, type Session } from './api.js';
import { PollAbort, pollUntil, waitIntent } from './poll.js';
import { loadState, type RunServer, type RunState } from './state.js';

const execFileAsync = promisify(execFile);

export const GIB = 1024 ** 3;

export interface TestUser {
  id: string;
  username: string;
  password: string;
  session: Session;
  /** Private key file registered with the user (only after `addSshKey`). */
  keyFile?: string;
}

type Cleanup = { label: string; run: () => Promise<unknown> };

/**
 * Per-scenario toolbox. Everything a scenario creates registers a cleanup
 * here; `cleanup()` runs them last-in-first-out and only logs failures,
 * because `e2e.sh down` sweeps whatever is left on the lab hosts.
 */
export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'nyabase-e2e-'));
  private readonly stack: Cleanup[] = [];

  private constructor(
    readonly state: RunState,
    readonly admin: Session,
  ) {}

  static async start(): Promise<Harness> {
    const state = loadState();
    const admin = await login(state.baseUrl, state.admin.username, state.admin.password);
    return new Harness(state, admin);
  }

  get api(): Api {
    return this.admin.api;
  }

  get server(): RunServer {
    return this.state.servers[0]!;
  }

  /** Unique, lower-case, ssh-login-safe resource name. */
  name(label: string): string {
    return `e${randomBytes(3).toString('hex')}-${label}`;
  }

  defer(label: string, run: () => Promise<unknown>): void {
    this.stack.push({ label, run });
  }

  async cleanup(): Promise<void> {
    while (this.stack.length > 0) {
      const item = this.stack.pop()!;
      try {
        await item.run();
      } catch (error) {
        console.error(`cleanup "${item.label}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Creates a user (role `user` unless given); deleted again on cleanup. */
  async newUser(label: string, role?: Role): Promise<TestUser> {
    const username = this.name(label);
    const password = `pw-${randomBytes(9).toString('hex')}`;
    const created = await this.api.post<UserDto>('/users', {
      username,
      password,
      displayName: `e2e ${label}`,
      ...(role ? { role } : {}),
    });
    this.defer(`delete user ${username}`, () => this.api.delete(`/users/${created.id}`));
    return { id: created.id, username, password, session: await login(this.state.baseUrl, username, password) };
  }

  /** Server grant with roomy defaults; removed again on cleanup. */
  async grantServer(
    user: Pick<TestUser, 'id'>,
    server: RunServer,
    overrides: Partial<PutServerGrantRequest> = {},
  ): Promise<void> {
    const body: PutServerGrantRequest = {
      cpuCores: 2,
      memBytes: 8 * GIB,
      diskBytes: 64 * GIB,
      gpuPciAddresses: [],
      expiresAt: null,
      ...overrides,
    };
    await this.api.put(`/users/${user.id}/server-grants/${server.id}`, body);
    this.defer(`revoke server grant ${user.id}/${server.slug}`, () =>
      this.api.delete(`/users/${user.id}/server-grants/${server.id}`));
  }

  async grantPool(user: Pick<TestUser, 'id'>, poolId: string): Promise<void> {
    await this.api.put(`/users/${user.id}/storage-pool-grants/${poolId}`, { expiresAt: null });
    this.defer(`revoke pool grant ${user.id}/${poolId}`, () =>
      this.api.delete(`/users/${user.id}/storage-pool-grants/${poolId}`));
  }

  async addSshKey(user: TestUser): Promise<SshPublicKeyDto> {
    const keyFile = join(this.dir, `key-${user.username}-${randomBytes(3).toString('hex')}`);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', user.username, '-f', keyFile]);
    user.keyFile = keyFile;
    return user.session.api.post<SshPublicKeyDto>(`/users/${user.id}/ssh-keys`, {
      name: 'e2e',
      keyText: readFileSync(`${keyFile}.pub`, 'utf8').trim(),
      currentPassword: user.password,
    });
  }

  /**
   * Creates a container as `user`, waits for it, and registers its deletion.
   * Waits for a running guest with a routed IP (and SSH readiness when the
   * user has a key); `powerIntent: stopped` only waits for the intent.
   */
  async createContainer(
    user: TestUser,
    server: RunServer,
    overrides: Partial<CreateContainerRequest> = {},
  ): Promise<ContainerDto> {
    const body: CreateContainerRequest = {
      serverId: server.id,
      imageId: this.state.image.id,
      name: this.name('c'),
      rootSizeBytes: this.state.rootSizeBytes,
      memBytes: GIB,
      powerIntent: ContainerPowerIntent.Running,
      ...overrides,
    };
    const accepted = await user.session.api.post<IntentAcceptedDto>('/containers', body);
    const id = accepted.resourceId;
    // Cleanup goes through the administrator: the owner may have lost access by then.
    this.defer(`delete container ${body.name}`, () => this.deleteContainer(this.api, id));
    await waitIntent(user.session.api, accepted);
    const wantRunning = body.powerIntent === ContainerPowerIntent.Running;
    return pollUntil(async () => {
      const container = await user.session.api.get<ContainerDto>(`/containers/${id}`);
      if (container.lifecyclePhase === ContainerPhase.Failed) {
        throw new PollAbort(new Error(`container ${id} failed: ${container.failureCode} ${container.failureReason}`));
      }
      if (container.lifecyclePhase !== ContainerPhase.Active) return undefined;
      if (!wantRunning) return container;
      const ready = container.actual.status === ContainerStatus.Running
        && (container.routedIp ?? container.actual.routedIp)
        && (user.keyFile === undefined || container.ssh.ready);
      return ready ? container : undefined;
    }, { timeoutMs: 420_000, what: `container ${body.name} to become ready` });
  }

  /**
   * `?scope=all` is the explicit administrator override for acting on someone
   * else's resource; the harness's own (administrator) client always sends it,
   * users' clients never do.
   */
  private scoped(api: Api, path: string): string {
    return api === this.api ? `${path}${path.includes('?') ? '&' : '?'}scope=all` : path;
  }

  /** Polls the container until `predicate` holds; a failed container aborts the wait. */
  async waitContainer(
    api: Api,
    id: string,
    predicate: (container: ContainerDto) => boolean,
    what: string,
    timeoutMs = 300_000,
  ): Promise<ContainerDto> {
    return pollUntil(async () => {
      const container = await api.get<ContainerDto>(this.scoped(api, `/containers/${id}`));
      if (container.lifecyclePhase === ContainerPhase.Failed) {
        throw new PollAbort(new Error(`container ${id} failed: ${container.failureCode} ${container.failureReason}`));
      }
      return predicate(container) ? container : undefined;
    }, { timeoutMs, what });
  }

  /** Posts a power action, waits for its intent and for the container to be `running`/`stopped`. */
  async power(
    api: Api,
    id: string,
    action: 'start' | 'stop' | 'restart',
    user?: Pick<TestUser, 'keyFile'>,
  ): Promise<ContainerDto> {
    const accepted = await api.post<IntentAcceptedDto>(this.scoped(api, `/containers/${id}/actions/${action}`));
    await waitIntent(api, accepted);
    const status = action === 'stop' ? ContainerStatus.Stopped : ContainerStatus.Running;
    return this.waitContainer(api, id, (c) => c.actual.status === status
      && (status !== ContainerStatus.Running || (!user?.keyFile || c.ssh.ready)), `container ${id} ${status}`);
  }

  async deleteContainer(api: Api, id: string): Promise<void> {
    let accepted: IntentAcceptedDto;
    try {
      accepted = await api.post<IntentAcceptedDto>(this.scoped(api, `/containers/${id}/actions/delete`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    await waitIntent(api, accepted);
    await pollUntil(async () => {
      try {
        await api.get(this.scoped(api, `/containers/${id}`));
        return undefined;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return true;
        throw error;
      }
    }, { timeoutMs: 300_000, what: `container ${id} to disappear` });
  }

  /** Deletes a local (`volumes`) or shared (`shared-volumes`) volume and waits until it is gone. */
  async deleteVolume(api: Api, id: string, collection: 'volumes' | 'shared-volumes' = 'volumes'): Promise<void> {
    let accepted: IntentAcceptedDto;
    try {
      accepted = await api.delete<IntentAcceptedDto>(this.scoped(api, `/${collection}/${id}`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    await waitIntent(api, accepted);
    await pollUntil(async () => {
      try {
        await api.get(this.scoped(api, `/${collection}/${id}`));
        return undefined;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return true;
        throw error;
      }
    }, { timeoutMs: 300_000, what: `volume ${id} to disappear` });
  }

  /** Runs `incus <args>` on the lab host of `server` (over ssh unless it is this machine). */
  async incus(server: RunServer, args: readonly string[]): Promise<string> {
    const [file, argv] = server.ssh === 'local'
      ? ['incus', [...args]]
      : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', server.ssh, 'incus', ...args.map(shellWord)]];
    const { stdout } = await execFileAsync(file, argv, { timeout: 60_000 });
    return stdout;
  }

  /** Runs a root shell command line on the lab host of `server`. */
  async onHost(server: RunServer, command: string): Promise<string> {
    const [file, argv] = server.ssh === 'local'
      ? ['bash', ['-c', command]]
      : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', server.ssh, command]];
    const { stdout } = await execFileAsync(file, argv, { timeout: 60_000 });
    return stdout;
  }

  /**
   * Runs `command` in the guest through the ssh-proxy jump host, as `user`,
   * the way a user would after the one-time setup: the ssh_config block and
   * known_hosts lines from their profile, strict host key checking, and the
   * container's host name (`<name>.<suffix>`). `target` overrides the host
   * (e.g. the routed IP, which known_hosts does not cover: pass
   * `strictHostKeys: false`); `jumpLogin` overrides the jump login;
   * `knownHostsFrom` trusts another user's known_hosts lines instead.
   * Resolves with stdout; rejects when ssh fails.
   */
  async ssh(
    user: TestUser,
    container: ContainerDto,
    command: string,
    options: { target?: string; jumpLogin?: string; strictHostKeys?: boolean; knownHostsFrom?: TestUser } = {},
  ): Promise<string> {
    if (!user.keyFile) throw new Error('user has no ssh key');
    const client = await user.session.api.get<SshClientConfigDto>(`/users/${user.id}/ssh-client-config`);
    if (!client.proxy || !client.sshConfig || !client.knownHosts) {
      throw new Error('the SSH proxy has no public address');
    }
    const trusted = options.knownHostsFrom
      ? await options.knownHostsFrom.session.api.get<SshClientConfigDto>(
        `/users/${options.knownHostsFrom.id}/ssh-client-config`,
      )
      : client;
    const tag = randomBytes(4).toString('hex');
    const knownHosts = join(this.dir, `known-hosts-${tag}`);
    writeFileSync(knownHosts, `${trusted.knownHosts}\n`);
    const config = join(this.dir, `ssh-${tag}.conf`);
    writeFileSync(config, [
      client.sshConfig,
      'Host *',
      `  IdentityFile ${user.keyFile}`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      `  StrictHostKeyChecking ${options.strictHostKeys === false ? 'no' : 'yes'}`,
      `  UserKnownHostsFile ${options.strictHostKeys === false ? '/dev/null' : knownHosts}`,
      '  LogLevel ERROR',
      '  ConnectTimeout 20',
    ].join('\n'));
    const target = options.target ?? container.ssh.hostName;
    const { host, port } = client.proxy;
    // A target outside `*.<suffix>` gets no ProxyJump from the config.
    const jump = options.jumpLogin || !target.endsWith(`.${client.hostSuffix}`)
      ? ['-o', `ProxyJump=${options.jumpLogin ?? user.username}@${host}:${port}`]
      : [];
    const { stdout } = await execFileAsync(
      'ssh',
      ['-F', config, ...jump, `${container.ssh.loginUser}@${target}`, command],
      { timeout: 60_000 },
    );
    return stdout;
  }
}

/** Quotes one argument for the remote shell ssh runs it in. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=@,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
