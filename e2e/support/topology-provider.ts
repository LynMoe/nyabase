import incusProvider from '../topology/incus/provider.js';
import {
  requireTopologyCapabilities,
  topologyCapabilities,
  type AvailableTopologyProvider,
  type TopologyCapability,
} from '../topology/provider.js';

const supportedProviders = new Map<string, AvailableTopologyProvider>([
  [incusProvider.id, incusProvider],
]);
const knownCapabilities = new Set<string>(topologyCapabilities);

export function resolveTopologyProvider(
  requestedId = process.env.E2E_TOPOLOGY_PROVIDER,
): AvailableTopologyProvider {
  const providerId = requestedId?.trim() || incusProvider.id;
  const provider = supportedProviders.get(providerId);
  if (!provider) {
    throw new Error(
      `E2E topology is BLOCKED: unknown provider ${providerId}; supported providers: ${
        [...supportedProviders.keys()].join(', ')
      }`,
    );
  }
  return provider;
}

export function parseRequiredTopologyCapabilities(
  profileName: string,
  value: unknown,
): readonly TopologyCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Invalid Incus E2E profile ${profileName}: requiredCapabilities must be non-empty`,
    );
  }
  const required = value.map((capability) => {
    if (typeof capability !== 'string' || !knownCapabilities.has(capability)) {
      throw new Error(
        `Invalid Incus E2E profile ${profileName}: unknown capability ${String(capability)}`,
      );
    }
    return capability as TopologyCapability;
  });
  if (new Set(required).size !== required.length) {
    throw new Error(`Invalid Incus E2E profile ${profileName}: duplicate capability`);
  }
  return required;
}

export function requireProfileTopologyCapabilities(
  provider: AvailableTopologyProvider,
  profileName: string,
  value: unknown,
): readonly TopologyCapability[] {
  const required = parseRequiredTopologyCapabilities(profileName, value);
  requireTopologyCapabilities(provider, required);
  return required;
}
