import type { ComponentType, ReactNode } from 'react';
import type { OpaqueExtensionMap, ServerExtensionEnablementDto } from '@nyabase/common';
import type { nvidiaGpuFormatError } from '../errors.js';
import type { NvidiaGpuDeviceDto } from '../schema.js';

export interface FrontendExtensionHost {
  readonly api: {
    get<T = unknown>(path: string): Promise<T>;
    patch(path: string, body: unknown): Promise<unknown>;
  };
  extensionDevicesKey(extensionId: string, serverId: string, admin: boolean): readonly unknown[];
  useQuery: <T>(options: {
    queryKey: readonly unknown[];
    queryFn: () => Promise<T>;
    enabled?: boolean;
  }) => { data: T | undefined; isPending: boolean; isError: boolean };
  toast: (opts: { title?: string; description?: string; variant?: string }) => void;
  readonly ui: {
    FormField: ComponentType<{ id: string; label: string; children?: ReactNode }>;
    Checkbox: ComponentType<{
      id?: string;
      checked?: boolean;
      disabled?: boolean;
      onCheckedChange?: (checked: boolean | 'indeterminate') => void;
    }>;
    Select: ComponentType<{
      value?: string;
      disabled?: boolean;
      onValueChange?: (value: string) => void;
      children?: ReactNode;
    }>;
    SelectContent: ComponentType<{ children?: ReactNode }>;
    SelectItem: ComponentType<{ value: string; children?: ReactNode }>;
    SelectTrigger: ComponentType<{ id?: string; children?: ReactNode }>;
    SelectValue: ComponentType;
    Button: ComponentType<{
      onClick?: () => void;
      disabled?: boolean;
      children?: ReactNode;
    }>;
    Card: ComponentType<{ className?: string; children?: ReactNode }>;
    CardHeader: ComponentType<{ children?: ReactNode }>;
    CardTitle: ComponentType<{ className?: string; children?: ReactNode }>;
    CardContent: ComponentType<{ className?: string; children?: ReactNode }>;
    CardDescription: ComponentType<{
      children?: ReactNode;
      'data-testid'?: string;
    }>;
  };
}

export interface SlotContextMap {
  'container.create': {
    serverId: string;
    enabledExtensions: string[];
    grant: OpaqueExtensionMap | null;
    value: OpaqueExtensionMap;
    onChange: (next: OpaqueExtensionMap) => void;
  };
  'container.spec': {
    containerId: string;
    serverId: string;
    enabledExtensions: string[];
    admin: boolean;
    observedStatus: string;
    value: OpaqueExtensionMap;
    onChange: (next: OpaqueExtensionMap) => void;
    onSubmit: (extensionId: string, payload: unknown) => void;
    pending: boolean;
  };
  'container.overview': {
    value: OpaqueExtensionMap;
    serverId: string;
  };
  'grant.server': {
    serverId: string;
    enabledExtensions: string[];
    value: OpaqueExtensionMap;
    onChange: (next: OpaqueExtensionMap) => void;
  };
  'server.detail.enablement': {
    serverId: string;
    item: ServerExtensionEnablementDto;
  };
  'server.detail.health': {
    serverId: string;
    item: ServerExtensionEnablementDto;
  };
  'server.preflight': {
    evidence: OpaqueExtensionMap;
  };
}

export interface ServerCardWebExtension {
  readonly id: string;
  readonly slots: Partial<{
    [A in keyof SlotContextMap]: (props: {
      host: FrontendExtensionHost;
      ctx: SlotContextMap[A];
    }) => ReactNode;
  }>;
  readonly formatError: typeof nvidiaGpuFormatError;
  readonly formatGrantSummary?: (grants: OpaqueExtensionMap) => string | null;
}

export type NvidiaGpuInventoryItem = NvidiaGpuDeviceDto;
