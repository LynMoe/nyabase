import { IncusError, normalizeCertificateFingerprint } from './incus-errors.js';
import type {
  IncusRequestOptions,
  IncusResponse,
  IncusSchema,
  IncusTrustCertificateOptions,
} from './incus-client-types.js';
import { encodeCertificateForPost, encodeSegment } from './incus-request-util.js';
import { IncusTransport } from './incus-transport.js';

/** Incus server, client-certificate and network endpoints. */
export class IncusServerApi extends IncusTransport {
  getServer(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Server'>>> {
    return this.requestJson('GET', '/1.0', options);
  }

  trustClientCertificate(
    trustToken: string,
    name: string,
    options: IncusTrustCertificateOptions = {},
  ): Promise<IncusResponse<unknown>> {
    const certificatePem =
      options.certificatePem ??
      (typeof this.tlsOptions.cert === 'string'
        ? this.tlsOptions.cert
        : this.tlsOptions.cert.toString('utf8'));
    return this.requestJson('POST', '/1.0/certificates', {
      ...options,
      body: {
        certificate: encodeCertificateForPost(certificatePem),
        name,
        type: 'client',
        ...(trustToken ? { trust_token: trustToken } : {}),
      },
    });
  }

  trustCertificate(
    certificatePem: string,
    name: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<unknown>> {
    return this.trustClientCertificate('', name, {
      ...options,
      certificatePem,
    });
  }

  async deleteClientCertificate(
    fingerprint: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<unknown>> {
    const normalized = normalizeCertificateFingerprint(fingerprint);
    try {
      return await this.requestJson(
        'DELETE',
        `/1.0/certificates/${encodeSegment(normalized, 'certificate_fingerprint')}`,
        options,
      );
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') {
        return {
          status: 404,
          headers: {},
          envelope: {
            type: 'sync',
            status: 'Success',
            status_code: 200,
            metadata: {},
          },
          metadata: {},
        };
      }
      throw error;
    }
  }

  updateServer(
    document: IncusSchema<'ServerPut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PUT', '/1.0', { ...options, body: document });
  }

  patchServer(
    document: Partial<IncusSchema<'ServerPut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PATCH', '/1.0', { ...options, body: document });
  }

  getResources(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Resources'>>> {
    return this.requestJson('GET', '/1.0/resources', options);
  }

  getNetwork(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Network'>>> {
    return this.requestJson(
      'GET',
      `/1.0/networks/${encodeSegment(name, 'network_name')}`,
      options,
    );
  }

  getNetworkState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'NetworkState'>>> {
    return this.requestJson(
      'GET',
      `/1.0/networks/${encodeSegment(name, 'network_name')}/state`,
      options,
    );
  }

  listNetworks(options?: IncusRequestOptions): Promise<IncusResponse<string[]>> {
    return this.requestJson('GET', '/1.0/networks', options);
  }
}
