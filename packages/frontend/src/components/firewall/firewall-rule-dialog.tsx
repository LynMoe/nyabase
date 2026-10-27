import { TriangleAlert } from 'lucide-react';
import {
  FIREWALL_MAX_CIDRS_PER_RULE,
  FIREWALL_PRIORITY_MAX,
  FIREWALL_PRIORITY_MIN,
  FirewallProtocol,
  type FirewallAction,
  type ServerDto,
} from '@nyabase/common';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { FormField, SelectField } from '../layout/form-field.js';
import {
  FIREWALL_ACTION_OPTIONS,
  FIREWALL_PROTOCOL_OPTIONS,
  firewallCidrCount,
} from '../../lib/firewall-rules.js';
import { cn } from '../../lib/utils.js';
import { useFirewallRuleEditor, type FirewallRuleEditorArgs } from './use-firewall-rule-editor.js';

/** Static, because the rules are: see R17 of the firewall design. */
export const FIREWALL_STATELESS_WARNING =
  '规则无状态，回包同样会被拦截；勿覆盖代理、DNS 或网关地址。';

export function FirewallRuleDialog({
  servers,
  ...args
}: FirewallRuleEditorArgs & { servers: ServerDto[] }) {
  const { open, onOpenChange, rule } = args;
  const { form, update, toggleServer, errors, serverError, submit, pending } = useFirewallRuleEditor(args);
  const cidrCount = firewallCidrCount(form.cidrs);
  const portsDisabled = form.protocol === FirewallProtocol.All;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="firewall-rule-editor">
        <DialogHeader>
          <DialogTitle>{rule ? '编辑防火墙规则' : '创建防火墙规则'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="firewall-rule-name" label="名称" error={errors.name}>
            <Input id="firewall-rule-name" value={form.name} onChange={(event) => update({ name: event.target.value })} />
          </FormField>
          <FormField
            id="firewall-rule-priority"
            label="优先级"
            hint="越小越先匹配"
            error={errors.priority}
          >
            <Input
              id="firewall-rule-priority"
              type="number"
              inputMode="numeric"
              min={FIREWALL_PRIORITY_MIN}
              max={FIREWALL_PRIORITY_MAX}
              value={form.priority}
              onChange={(event) => update({ priority: event.target.value })}
            />
          </FormField>
          <div className="sm:col-span-2">
            <FormField id="firewall-rule-description" label="描述（可选）">
              <Input
                id="firewall-rule-description"
                value={form.description}
                onChange={(event) => update({ description: event.target.value })}
              />
            </FormField>
          </div>
          <SelectField
            id="firewall-rule-action"
            label="动作"
            value={form.action}
            onChange={(value) => update({ action: value as FirewallAction })}
            options={FIREWALL_ACTION_OPTIONS}
          />
          <SelectField
            id="firewall-rule-protocol"
            label="协议"
            value={form.protocol}
            onChange={(value) => update({ protocol: value as FirewallProtocol })}
            options={FIREWALL_PROTOCOL_OPTIONS}
          />
          <div className="sm:col-span-2">
            <FormField
              id="firewall-rule-ports"
              label="目标端口"
              hint={portsDisabled ? undefined : '留空为全部端口'}
              error={errors.ports}
            >
              <Input
                id="firewall-rule-ports"
                className="font-mono"
                value={form.ports}
                disabled={portsDisabled}
                placeholder={portsDisabled ? '全部端口' : '22, 80, 8000-9000'}
                onChange={(event) => update({ ports: event.target.value })}
              />
            </FormField>
          </div>
          <div className="sm:col-span-2">
            <FormField
              id="firewall-rule-cidrs"
              label="目标网段（每行一个）"
              hint={`${cidrCount} / ${FIREWALL_MAX_CIDRS_PER_RULE}`}
              error={errors.cidrs}
            >
              <Textarea
                id="firewall-rule-cidrs"
                className={cn('min-h-[120px] font-mono', cidrCount > FIREWALL_MAX_CIDRS_PER_RULE && 'border-destructive')}
                value={form.cidrs}
                placeholder={'10.0.0.0/8\n192.168.1.10'}
                onChange={(event) => update({ cidrs: event.target.value })}
              />
            </FormField>
          </div>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">关联服务器</p>
          {servers.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无服务器可关联。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {servers.map((server) => (
                <label key={server.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`firewall-rule-server-${server.id}`}
                    checked={form.serverIds.includes(server.id)}
                    onCheckedChange={(checked) => toggleServer(server.id, checked === true)}
                  />
                  <span className="truncate">{server.name}</span>
                  {server.slug && server.slug !== server.name && (
                    <span className="truncate font-mono text-xs text-muted-foreground">{server.slug}</span>
                  )}
                </label>
              ))}
            </div>
          )}
          {form.serverIds.length === 0 && (
            <p className="text-xs text-muted-foreground">未关联服务器，规则不生效</p>
          )}
        </div>
        <Alert variant="warning" data-testid="firewall-rule-stateless-warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription className="text-xs">{FIREWALL_STATELESS_WARNING}</AlertDescription>
        </Alert>
        {(serverError ?? errors.form) && <p className="text-sm text-destructive">{serverError ?? errors.form}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>取消</Button>
          <Button onClick={submit} disabled={pending}>{pending ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
