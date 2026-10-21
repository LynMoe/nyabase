import { Link } from '@tanstack/react-router';
import type { HttpDomainPoolPublicDto, HttpProxyBindingDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { FormField } from '../../components/layout/form-field.js';
import { httpProxyDomainRootLabel } from '../../lib/http-proxy.js';
import { useBindingForm } from './use-binding-form.js';

export function BindingFormDialog({
  binding,
  pools,
  open,
  onOpenChange,
}: {
  binding?: HttpProxyBindingDto;
  pools: HttpDomainPoolPublicDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useBindingForm({ binding, pools, open, onOpenChange });
  const containers = form.containersQuery.data ?? [];
  const { selectedPool } = form;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="http-proxy-binding-form">
        <DialogHeader>
          <DialogTitle>{binding ? '编辑 HTTP 发布' : '新建 HTTP 发布'}</DialogTitle>
          <DialogDescription>
            选择域名根，只填写前缀。完整主机名形如 app.example.com。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {pools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              当前没有已启用的通配域名，请联系管理员在「HTTP 代理」中创建。
            </p>
          ) : (
            <>
              <FormField id="http-proxy-domain-root" label="域名根">
                <Select value={selectedPool?.id} onValueChange={form.setPoolId}>
                  <SelectTrigger id="http-proxy-domain-root">
                    <SelectValue placeholder="选择域名根" />
                  </SelectTrigger>
                  <SelectContent>
                    {pools.map((pool) => (
                      <SelectItem key={pool.id} value={pool.id}>
                        {httpProxyDomainRootLabel(pool.wildcardDomain)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                id="http-proxy-prefix"
                label="主机前缀"
                hint={form.hostnamePreview ? `完整主机名 ${form.hostnamePreview}` : undefined}
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="http-proxy-prefix"
                    className="font-mono"
                    value={form.prefix}
                    placeholder="app"
                    autoComplete="off"
                    onChange={(event) => form.setPrefix(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  />
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">{form.suffix}</span>
                </div>
              </FormField>
            </>
          )}
          <FormField id="http-proxy-container" label="容器">
            <Select value={form.containerId || undefined} onValueChange={form.setContainerId}>
              <SelectTrigger id="http-proxy-container">
                <SelectValue placeholder={form.containersQuery.isLoading ? '加载容器…' : '选择容器'} />
              </SelectTrigger>
              <SelectContent>
                {containers.map((container) => (
                  <SelectItem key={container.id} value={container.id}>
                    {container.name} · {container.serverName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!form.containersQuery.isLoading && containers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                还没有容器。<Link to="/containers" className="underline">去创建容器</Link>
              </p>
            )}
          </FormField>
          <FormField id="http-proxy-port" label="目标端口">
            <Input
              id="http-proxy-port"
              type="number"
              min="1"
              max="65535"
              value={form.targetPort}
              onChange={(event) => form.setTargetPort(event.target.value)}
            />
          </FormField>
          {form.error && <p className="text-sm text-destructive">{form.error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={form.submit} disabled={form.pending || pools.length === 0}>
            {form.pending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
