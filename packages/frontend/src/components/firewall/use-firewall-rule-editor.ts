import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FailureCode,
  FirewallProtocol,
  type CreateFirewallRuleRequest,
  type FirewallRuleDto,
  type PatchFirewallRuleRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { ApiError } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  emptyFirewallRuleForm,
  firewallErrorMessage,
  firewallRuleForm,
  firewallRulePatch,
  parseFirewallCidrsField,
  parseFirewallPortsField,
  validateFirewallRuleForm,
  type FirewallFormErrors,
  type FirewallRuleForm,
} from '../../lib/firewall-rules.js';

export interface FirewallRuleEditorArgs {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null creates a rule. */
  rule: FirewallRuleDto | null;
  defaultPriority: number;
  serverName: (id: string) => string | undefined;
}

export function useFirewallRuleEditor({ open, onOpenChange, rule, defaultPriority, serverName }: FirewallRuleEditorArgs) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FirewallRuleForm>(() => emptyFirewallRuleForm(defaultPriority));
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(rule ? firewallRuleForm(rule) : emptyFirewallRuleForm(defaultPriority));
    setAttempted(false);
    setServerError(null);
    // defaultPriority is read when the dialog opens; later list refreshes must not reset the draft.
  }, [open, rule]);

  const onSaved = (title: string) => {
    toast({ title });
    void queryClient.invalidateQueries({ queryKey: queryKeys.firewall.all });
    onOpenChange(false);
  };
  const onFailed = (error: unknown) => {
    if (error instanceof ApiError && error.code === FailureCode.RevisionConflict) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.firewall.rules });
    }
    setServerError(firewallErrorMessage(error, serverName));
  };
  const create = useMutation({
    mutationFn: (body: CreateFirewallRuleRequest) => api.post<FirewallRuleDto>('/admin/firewall-rules', body),
    onSuccess: () => onSaved('防火墙规则已创建'),
    onError: onFailed,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchFirewallRuleRequest }) =>
      api.patch<FirewallRuleDto>(`/admin/firewall-rules/${id}`, body),
    onSuccess: () => onSaved('防火墙规则已更新'),
    onError: onFailed,
  });

  const validation = useMemo(() => validateFirewallRuleForm(form), [form]);
  /** Before the first save only malformed input is flagged; after it, everything that blocks saving. */
  const errors: FirewallFormErrors = useMemo(() => {
    if (attempted) return validation.errors ?? {};
    const live: FirewallFormErrors = {};
    if (form.ports.trim()) live.ports = parseFirewallPortsField(form.ports, form.protocol).error ?? undefined;
    if (form.cidrs.trim()) live.cidrs = parseFirewallCidrsField(form.cidrs).error ?? undefined;
    return live;
  }, [attempted, validation, form.ports, form.protocol, form.cidrs]);

  const update = (changes: Partial<FirewallRuleForm>) => {
    setForm((current) => {
      const next = { ...current, ...changes };
      // Ports only exist for tcp / udp.
      if (next.protocol === FirewallProtocol.All) next.ports = '';
      return next;
    });
    setServerError(null);
  };
  const toggleServer = (serverId: string, checked: boolean) => {
    update({
      serverIds: checked
        ? [...new Set([...form.serverIds, serverId])]
        : form.serverIds.filter((id) => id !== serverId),
    });
  };

  const submit = () => {
    setAttempted(true);
    if (!validation.body) return;
    if (!rule) {
      create.mutate(validation.body);
      return;
    }
    const body = firewallRulePatch(rule, validation.body);
    if (!body) {
      toast({ title: '没有需要保存的修改' });
      onOpenChange(false);
      return;
    }
    patch.mutate({ id: rule.id, body });
  };

  return {
    form,
    update,
    toggleServer,
    errors,
    serverError,
    submit,
    pending: create.isPending || patch.isPending,
  };
}
