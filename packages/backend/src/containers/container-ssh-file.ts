import { IncusError, type IncusClientPort } from '../incus/index.js';
import type { IncusContainerSshStateAdapter } from './container-ssh-state.adapter.js';
import {
  running,
  sshFileMetadata,
  sshFileNeedsReconcile,
  sshObservation,
  type ContainerRow,
  type InstanceState,
  type SshFileObservation,
} from './container-reconcile-support.js';

/** Write the owner's authorized_keys into the guest and probe sshd when the instance runs. */
export async function reconcileSshFile(
  sshState: IncusContainerSshStateAdapter,
  client: IncusClientPort,
  row: ContainerRow,
  name: string,
  state: InstanceState,
  signal: AbortSignal,
): Promise<SshFileObservation> {
  if (!row.ssh_public_key) {
    return { status: 'disabled', lastError: null };
  }
  const content = `${row.ssh_public_key.trim()}\n`;
  const path = row.login_user === 'root'
    ? '/root/.ssh/authorized_keys'
    : `/home/${row.login_user}/.ssh/authorized_keys`;
  const homeMetadata = row.login_user === 'root'
    ? null
    : await sshState.readHomeDirectoryMetadata(client, name, `/home/${row.login_user}`, signal);
  const desiredMetadata = sshFileMetadata(row.login_user, homeMetadata);
  let actual = await sshState.readAuthorizedKeys(client, name, path, signal);
  if (sshFileNeedsReconcile({ actual, desiredContent: content, desiredMetadata })) {
    try {
      await sshState.writeAuthorizedKeys(client, name, path, content, desiredMetadata, signal);
    } catch (error) {
      if (!(error instanceof IncusError) || error.code !== 'INCUS_TIMEOUT') throw error;
      const afterTimeout = await sshState.readAuthorizedKeys(client, name, path, signal);
      if (sshFileNeedsReconcile({
        actual: afterTimeout,
        desiredContent: content,
        desiredMetadata,
      })) {
        throw error;
      }
    }
    actual = await sshState.readAuthorizedKeys(client, name, path, signal);
  }
  if (sshFileNeedsReconcile({ actual, desiredContent: content, desiredMetadata })) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'ssh_file_state_mismatch',
      path,
    });
  }

  if (!running(state)) {
    return { status: 'container_stopped', lastError: null };
  }
  const sshd = await sshState.probeSshd(client, name, signal);
  const observation = sshObservation(sshd);
  if (observation.status === 'unknown') {
    // Key is applied but sshd is not accepting connections yet — retry rather
    // than settling create as succeeded with a false "ready" signal.
    throw new IncusError('SSH_DAEMON_PENDING', 'retry', {
      reason: 'sshd_not_listening',
      path,
    });
  }
  return observation;
}
