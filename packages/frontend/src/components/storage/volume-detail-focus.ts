import { useState } from 'react';

/**
 * The volume whose detail dialog is open, when a page keeps it in the URL
 * (`?volume=<id>`) so other pages can link straight to it.
 */
export interface VolumeDetailFocus {
  id: string | null;
  onChange: (id: string | null) => void;
}

/** The open detail: the page's focus when given, otherwise table-local state. */
export function useVolumeDetail<T extends { id: string }>(
  volumes: readonly T[],
  focus: VolumeDetailFocus | undefined,
): [T | null, (volume: T | null) => void] {
  const [localId, setLocalId] = useState<string | null>(null);
  const id = focus ? focus.id : localId;
  const change = focus ? focus.onChange : setLocalId;
  const detail = id ? volumes.find((volume) => volume.id === id) ?? null : null;
  return [detail, (volume) => change(volume?.id ?? null)];
}

export function parseVolumeSearch(search: Record<string, unknown>): { volume?: string } {
  return typeof search.volume === 'string' && search.volume ? { volume: search.volume } : {};
}
