import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  type CreatedServerDto,
  type CreateServerRequest,
  SERVER_NAME_MAX_WIDTH,
  zCreateServerRequest,
} from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { EnrollmentInstructions } from '../../components/servers/agent-enrollment.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { parseCpuList } from '../../lib/cpu-set.js';
import { toast } from '../../hooks/use-toast.js';

type OnboardingForm = {
  name: string;
  slug: string;
  parentInterface: string;
  dnsServers: string;
  reservedCpus: string;
};

const emptyOnboardingForm: OnboardingForm = {
  name: '',
  slug: '',
  parentInterface: 'eth0',
  dnsServers: '',
  reservedCpus: '',
};

const FIELDS: Array<[keyof OnboardingForm, string, string]> = [
  ['name', `显示名称（最宽 ${SERVER_NAME_MAX_WIDTH} 列，中文算 2）`, 'prod-incus-1'],
  ['slug', '标识', 'prod-incus-1'],
  ['parentInterface', 'LAN 网桥 (vmbr)', 'vmbr0'],
  ['dnsServers', 'DNS（逗号分隔）', '1.1.1.1,8.8.8.8'],
  ['reservedCpus', '保留 CPU（可选）', '0,1 或 0-1'],
];

/**
 * Registers a server, then shows its one-time agent enrollment token. The
 * dialog stays on the token until the operator confirms they saved it.
 */
export function ServerOnboardingDialog({
  open,
  onOpenChange,
  onCreated,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onDone: (serverId: string) => void;
}) {
  const [form, setForm] = useState<OnboardingForm>(emptyOnboardingForm);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedServerDto | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateServerRequest) => api.post<CreatedServerDto>('/servers', body),
    onSuccess: (server) => {
      toast({ title: '服务器已登记', description: '请在服务器上安装接入令牌以启动 Agent。' });
      setForm(emptyOnboardingForm);
      setError(null);
      setCreated(server);
      onCreated();
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  useEffect(() => {
    if (!open) {
      setForm(emptyOnboardingForm);
      setError(null);
      setCreated(null);
    }
  }, [open]);

  const update = (key: keyof OnboardingForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const submit = () => {
    const reserved = parseCpuList(form.reservedCpus);
    if (!reserved.ok) {
      setError(`保留 CPU：${reserved.error}`);
      return;
    }
    const parsed = zCreateServerRequest.safeParse({
      name: form.name,
      slug: form.slug,
      parentInterface: form.parentInterface,
      dnsServers: splitList(form.dnsServers),
      reservedCpus: reserved.cpus,
    } satisfies CreateServerRequest);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查服务器参数');
      return;
    }
    create.mutate(parsed.data);
  };

  const finish = () => {
    if (created) onDone(created.id);
    else onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && created) finish(); else onOpenChange(next); }}>
      <DialogContent
        data-testid="server-onboarding"
        className={created ? 'sm:max-w-2xl' : undefined}
        // The token is shown once: a stray click outside must not dismiss it.
        onInteractOutside={created ? (event) => event.preventDefault() : undefined}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>安装主机 Agent</DialogTitle>
              <DialogDescription>
                「{created.name}」已登记。
              </DialogDescription>
            </DialogHeader>
            <EnrollmentInstructions enrollment={created.enrollment} />
            <DialogFooter>
              <Button onClick={finish}>我已保存，前往服务器</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>服务器接入</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map(([key, label, placeholder]) => (
                <div
                  key={key}
                  className={key === 'name' || key === 'slug' ? 'space-y-1.5' : 'space-y-1.5 sm:col-span-2'}
                >
                  <Label htmlFor={`server-onboarding-${key}`}>{label}</Label>
                  <Input
                    id={`server-onboarding-${key}`}
                    value={form[key]}
                    placeholder={placeholder}
                    className={key === 'slug' || key === 'reservedCpus' ? 'truncate font-mono' : undefined}
                    onChange={(event) => update(key, event.target.value)}
                  />
                </div>
              ))}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button onClick={submit} disabled={create.isPending}>{create.isPending ? '登记中...' : '登记服务器'}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}
