import type { ComponentType, ReactNode } from 'react';
import type {
  ExtensionErrorFormatter,
  OpaqueExtensionMap,
  ServerCardUiArea,
  ServerExtensionEnablementDto,
} from '@nyabase/common';
import type { api } from '../lib/api.js';
import type { FormField } from '../components/layout/form-field.js';
import type { Checkbox } from '../components/ui/checkbox.js';
import type {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import type { Button } from '../components/ui/button.js';
import type { TechnicalId } from '../components/refs/technical-id.js';
import type {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';

export interface FrontendExtensionHost {
  readonly api: typeof api;
  extensionDevicesKey(extensionId: string, serverId: string, admin: boolean): readonly unknown[];
  useQuery: <T>(options: {
    queryKey: readonly unknown[];
    queryFn: () => Promise<T>;
    enabled?: boolean;
  }) => { data: T | undefined; isPending: boolean; isError: boolean };
  toast: (opts: { title?: string; description?: string; variant?: string }) => void;
  readonly ui: {
    FormField: typeof FormField;
    Checkbox: typeof Checkbox;
    Select: typeof Select;
    SelectContent: typeof SelectContent;
    SelectItem: typeof SelectItem;
    SelectTrigger: typeof SelectTrigger;
    SelectValue: typeof SelectValue;
    Button: typeof Button;
    Card: typeof Card;
    CardHeader: typeof CardHeader;
    CardTitle: typeof CardTitle;
    CardContent: typeof CardContent;
    CardDescription: typeof CardDescription;
    TechnicalId: typeof TechnicalId;
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
    grant: OpaqueExtensionMap | null;
    value: OpaqueExtensionMap;
    onChange: (next: OpaqueExtensionMap) => void;
    onSubmit: (extensionId: string, payload: unknown) => void;
    pending: boolean;
  };
  'container.overview': {
    value: OpaqueExtensionMap;
    serverId: string;
    admin: boolean;
  };
  'grant.server': {
    serverId: string;
    enabledExtensions: string[];
    value: OpaqueExtensionMap;
    onChange: (next: OpaqueExtensionMap) => void;
  };
  'server.detail.enablement': { serverId: string; item: ServerExtensionEnablementDto };
  'server.detail.health': { serverId: string; item: ServerExtensionEnablementDto };
  'server.preflight': { evidence: OpaqueExtensionMap };
}

export interface ServerCardWebExtension {
  readonly id: string;
  readonly slots: Partial<{
    [A in ServerCardUiArea]: (props: {
      host: FrontendExtensionHost;
      ctx: SlotContextMap[A];
    }) => ReactNode;
  }>;
  readonly formatError: ExtensionErrorFormatter;
  readonly formatGrantSummary?: (grants: OpaqueExtensionMap) => string | null;
}

export type { ComponentType };
