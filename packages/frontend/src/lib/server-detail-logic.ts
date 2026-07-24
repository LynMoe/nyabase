import { Capability } from '@nyabase/common';

export interface ServerEditIdentity {
  name: string;
  slug: string;
}

export function canViewAdminServerMetrics(capabilities: readonly Capability[]): boolean {
  return capabilities.includes(Capability.ViewMetricsAll);
}

export function createServerEditDraft(server: ServerEditIdentity): ServerEditIdentity {
  return { name: server.name, slug: server.slug };
}

export function buildServerEditPatch(
  original: ServerEditIdentity,
  draft: ServerEditIdentity,
): Partial<ServerEditIdentity> {
  const patch: Partial<ServerEditIdentity> = {};
  const name = draft.name.trim();
  const slug = draft.slug.trim();
  if (name !== original.name) patch.name = name;
  if (slug !== original.slug) patch.slug = slug;
  return patch;
}
