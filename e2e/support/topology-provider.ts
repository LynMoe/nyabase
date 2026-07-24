import dockerDindProvider from '../topology/docker-dind/provider.js';
import {
  requireTopologyCapabilities,
  topologyCapabilities,
  topologyNodeKeys,
  type AvailableTopologyProvider,
  type TopologyCapability,
  type TopologyNodeKey,
} from '../topology/provider.js';

const supportedProviders = new Map<string, AvailableTopologyProvider>([
  [dockerDindProvider.id, dockerDindProvider],
]);
const knownCapabilities = new Set<string>(topologyCapabilities);
const knownNodeKeys = new Set<string>(topologyNodeKeys);

export function parseTopologyNodeKey(value: unknown): TopologyNodeKey {
  if (typeof value !== 'string' || !knownNodeKeys.has(value)) {
    throw new Error(`Invalid topology node key: ${String(value)}`);
  }
  return value as TopologyNodeKey;
}

/**
 * The provider is selected before Playwright discovers tests. An omitted value
 * deliberately means docker-dind; an explicit value must name a provider that
 * is actually wired, never a future descriptor or an inferred implementation.
 */
export function resolveTopologyProvider(
  requestedId = process.env.E2E_TOPOLOGY_PROVIDER,
): AvailableTopologyProvider {
  const providerId = requestedId === undefined ? dockerDindProvider.id : requestedId.trim();
  if (providerId.length === 0) {
    throw new Error('E2E topology is BLOCKED: an explicit provider id must not be empty');
  }
  const provider = supportedProviders.get(providerId);
  if (!provider) {
    throw new Error(
      `E2E topology is BLOCKED: provider ${providerId} is not wired; supported providers: ${[
        ...supportedProviders.keys(),
      ].join(', ')}`,
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
      `Invalid CPU E2E profile ${profileName}: requiredCapabilities must be a non-empty array`,
    );
  }

  const required: TopologyCapability[] = [];
  for (const capability of value) {
    if (typeof capability !== 'string' || !knownCapabilities.has(capability)) {
      throw new Error(
        `Invalid CPU E2E profile ${profileName}: unknown topology capability ${String(capability)}`,
      );
    }
    required.push(capability as TopologyCapability);
  }

  if (new Set(required).size !== required.length) {
    throw new Error(`Invalid CPU E2E profile ${profileName}: duplicate requiredCapabilities`);
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
