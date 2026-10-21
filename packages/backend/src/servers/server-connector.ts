import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  IncusError,
  normalizeCertificateFingerprint,
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
  type IncusResponse,
  type IncusSchema,
} from '../incus/index.js';
import type { EphemeralStore } from '../platform/ephemeral-store.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type { ServerPreflightStore } from './server-preflight.store.js';
import {
  ServerRevisionChangedError,
  TRUST_PROPAGATION_RETRY_DELAYS_MS,
  normalized,
  revisionNumber,
  trustTokenReference,
  type ServerRow,
} from './server-preflight-support.js';

function classifyTrustMutationFailure(error: unknown): unknown {
  if (
    error instanceof IncusError &&
    (error.code === 'INCUS_TIMEOUT' ||
      error.code === 'SERVER_UNREACHABLE' ||
      error.code === 'TLS_ERROR' ||
      error.code === 'TLS_PIN_MISMATCH')
  ) {
    return error;
  }
  if (error instanceof IncusError) {
    return new IncusError('TRUST_TOKEN_REJECTED', 'managed_failure', {
      reason: error.code,
    });
  }
  return error;
}

async function isClientTrusted(client: IncusClientPort, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await client.getServer({ signal });
    return response.metadata.auth === 'trusted';
  } catch {
    return false;
  }
}

async function waitForTrustPropagation(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new IncusError('INCUS_TIMEOUT', 'retry', {
      phase: 'trust_propagation',
    });
  }
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const abort = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(
        new IncusError('INCUS_TIMEOUT', 'retry', {
          phase: 'trust_propagation',
        }),
      );
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Establishes and verifies the control plane's relationship with one Incus
 * server: trusting our client certificate with a one-time token, pinning the
 * server identity and recording the server as online.
 */
export class ServerConnector {
  constructor(
    private readonly store: ServerPreflightStore,
    private readonly ephemeral: EphemeralStore,
  ) {}

  async connectWithTrustToken(
    client: IncusClientPort,
    server: ServerRow,
    intent: IntentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    await this.store.withServerConnectLock(server.id, () => (
      this.connectWithClaimedTrustToken(client, server, intent, signal)
    ));
  }

  /** Claim the one-time trust token inside the onboarding lock. */
  private claimTrustToken(
    server: ServerRow,
    reference: string | null,
    claimId: string,
    onClaimed: () => void,
  ): Promise<string> {
    return this.store.inOnboardingLock(async () => {
      if (!reference) {
        throw new IncusError('TRUST_TOKEN_MISSING', 'managed_failure', {
          reason: 'trust_token_reference_missing',
        });
      }
      const token = this.ephemeral.claimTrustToken(server.id, reference, claimId);
      if (token) onClaimed();
      if (!token) {
        throw new IncusError('TRUST_TOKEN_MISSING', 'managed_failure', {
          reason: 'trust_token_expired_or_lost_on_restart',
        });
      }
      return token;
    });
  }

  private async connectWithClaimedTrustToken(
    client: IncusClientPort,
    server: ServerRow,
    intent: IntentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const reference = trustTokenReference(intent.request);
    const claimId = randomUUID();
    let claimed = false;
    let trustMutationSucceeded = false;
    let claimConsumed = false;
    try {
      // Trust is a property of the Incus server, not of local state: a client
      // that is already trusted (for example a retry after the trust call
      // succeeded but the token commit was lost) needs no token.
      const alreadyTrusted = await isClientTrusted(client, signal);
      const trustToken = alreadyTrusted
        ? null
        : await this.claimTrustToken(server, reference, claimId, () => {
          claimed = true;
        });

      if (trustToken) {
        try {
          await readAfterTimeout(
            () =>
              requestAndWait(
                client,
                (options) =>
                  client.trustClientCertificate(trustToken, `nyabase-${normalized(server.id)}`, {
                    ...options,
                    signal,
                  }),
                { signal },
              ),
            async () => {
              await client.getServer({ signal });
              return undefined;
            },
          );
        } catch (error) {
          throw classifyTrustMutationFailure(error);
        }
        trustMutationSucceeded = true;
        const consumed = this.ephemeral.consumeClaimedTrustToken(
          server.id,
          reference!,
          claimId,
        );
        if (!consumed) {
          throw new IncusError('TRUST_TOKEN_UNAVAILABLE', 'retry', {
            reason: 'trust_token_commit_lost_after_trust',
          });
        }
        claimConsumed = true;
      }

      const expectedFingerprint =
        typeof intent.request?.expectedServerCertFingerprint === 'string'
          ? intent.request.expectedServerCertFingerprint
          : undefined;
      await this.connectWithPropagationRetry(
        client,
        server,
        expectedFingerprint,
        revisionNumber(server.revision),
        signal,
      );
    } finally {
      if (claimed && !claimConsumed && !trustMutationSucceeded && reference) {
        this.ephemeral.releaseClaimedTrustToken(server.id, reference, claimId);
      }
    }
  }

  private async connectWithPropagationRetry(
    client: IncusClientPort,
    server: ServerRow,
    expectedFingerprint: string | undefined,
    expectedRevision: number | undefined,
    signal: AbortSignal,
  ): Promise<IncusResponse<IncusSchema<'Server'>>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.connect(client, server, expectedFingerprint, expectedRevision, signal);
      } catch (error) {
        const delayMs = TRUST_PROPAGATION_RETRY_DELAYS_MS[attempt];
        if (!(error instanceof IncusError) || error.code !== 'TLS_ERROR' || delayMs === undefined) {
          throw error;
        }
        await waitForTrustPropagation(delayMs, signal);
      }
    }
  }

  /** Read the server, check its name and certificate pin, and record it as online. */
  async connect(
    client: IncusClientPort,
    server: ServerRow,
    expectedFingerprint?: string,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<IncusResponse<IncusSchema<'Server'>>> {
    let response;
    try {
      response = signal ? await client.getServer({ signal }) : await client.getServer();
    } catch (error) {
      if (
        error instanceof IncusError &&
        (error.code === 'TLS_ERROR' || error.code === 'TLS_PIN_MISMATCH')
      ) {
        await this.store.markStatus(server.id, 'unknown', error.message, expectedRevision);
      } else {
        await this.store.markUnreachable(server.id, error, expectedRevision);
      }
      throw error;
    }
    const environment = response.metadata.environment;
    const actualName = environment?.server_name;
    const actualFingerprint = environment?.certificate_fingerprint
      ?.replace(/[:-\s]/g, '')
      .toLowerCase();
    if (actualName && actualName !== server.name) {
      await this.store.markStatus(
        server.id,
        'unknown',
        'Incus server identity mismatch',
        expectedRevision,
      );
      throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
        expectedName: server.name,
        actualName,
      });
    }
    const pinnedFingerprint = expectedFingerprint ?? server.server_cert_fingerprint ?? undefined;
    if (
      (expectedFingerprint &&
        (!actualFingerprint ||
          normalizeCertificateFingerprint(expectedFingerprint) !== actualFingerprint)) ||
      (pinnedFingerprint &&
        (!actualFingerprint ||
          normalizeCertificateFingerprint(pinnedFingerprint) !== actualFingerprint))
    ) {
      await this.store.markStatus(
        server.id,
        'unknown',
        'Incus certificate fingerprint mismatch',
        expectedRevision,
      );
      throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
        ...(expectedFingerprint || pinnedFingerprint
          ? { expectedFingerprint: expectedFingerprint ?? pinnedFingerprint }
          : {}),
        ...(actualFingerprint ? { actualFingerprint } : {}),
      });
    }
    if (
      !(await this.store.projectServer(server.id, expectedRevision, {
        status: 'online',
        server_cert_fingerprint: actualFingerprint ?? server.server_cert_fingerprint,
        incus_version: environment?.server_version ?? null,
        api_extensions: response.metadata.api_extensions ?? [],
        last_seen_at: sql<Date>`clock_timestamp()`,
        last_error: null,
      }))
    ) {
      throw new ServerRevisionChangedError();
    }
    return response;
  }
}
