import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { IncusClientPort, IncusResponse, IncusSchema } from '../incus/index.js';
import {
  ServerRevisionChangedError,
  ServerPreflightStore,
  type ServerRow,
} from './server-preflight.store.js';

/**
 * Confirms a server answers through its agent and records it as online. The
 * agent credential already proves the server's identity, so there is no
 * name or certificate pinning here.
 */
@Injectable()
export class ServerConnector {
  constructor(private readonly store: ServerPreflightStore) {}

  async connect(
    client: IncusClientPort,
    server: ServerRow,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<IncusResponse<IncusSchema<'Server'>>> {
    let response;
    try {
      response = await client.getServer(signal ? { signal } : undefined);
    } catch (error) {
      await this.store.markUnreachable(server.id, error, expectedRevision);
      throw error;
    }
    if (
      !(await this.store.projectServer(server.id, expectedRevision, {
        status: 'online',
        incus_version: response.metadata.environment?.server_version ?? null,
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
