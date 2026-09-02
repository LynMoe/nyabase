import { api } from '../lib/api.js';
import { toast } from '../hooks/use-toast.js';
import { FormField } from '../components/layout/form-field.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import type { FrontendExtensionHost } from './types.js';

export const frontendExtensionHost: FrontendExtensionHost = {
  api,
  extensionDevicesKey(extensionId, serverId, admin) {
    return ['server-card-extension', extensionId, 'devices', admin ? 'admin' : 'user', serverId];
  },
  toast(opts) {
    toast({
      title: opts.title,
      description: opts.description,
      variant: opts.variant === 'destructive' ? 'destructive' : 'default',
    });
  },
  ui: {
    FormField,
    Checkbox,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Button,
    Card,
    CardHeader,
    CardTitle,
    CardContent,
    CardDescription,
  },
};
