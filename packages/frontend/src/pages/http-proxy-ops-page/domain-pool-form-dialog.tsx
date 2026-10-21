import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  zCreateHttpDomainPoolRequest,
  zPatchHttpDomainPoolRequest,
  type CreateHttpDomainPoolRequest,
  type HttpDomainPoolDto,
  type PatchHttpDomainPoolRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { FormField } from '../../components/layout/form-field.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { httpProxyErrorMessage } from '../../lib/http-proxy.js';

export function DomainPoolFormDialog({
  pool,
  open,
  onOpenChange,
}: {
  pool?: HttpDomainPoolDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [wildcardDomain, setWildcardDomain] = useState(pool?.wildcardDomain ?? '');
  const [enabled, setEnabled] = useState(pool?.enabled ?? true);
  const [httpsEnabled, setHttpsEnabled] = useState(pool?.httpsEnabled ?? false);
  const [certificatePem, setCertificatePem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateHttpDomainPoolRequest) => api.post<HttpDomainPoolDto>('/http-proxy/domain-pools', body),
    onSuccess: () => {
      toast({ title: '域名池已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: PatchHttpDomainPoolRequest) => api.patch<HttpDomainPoolDto>(`/http-proxy/domain-pools/${pool?.id ?? ''}`, body),
    onSuccess: () => {
      toast({ title: '域名池已更新' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const httpsNeedsPem = httpsEnabled && (!pool?.httpsEnabled || !pool.certificateFingerprint);
  const httpsPemIncomplete = httpsEnabled && (
    Boolean(certificatePem.trim()) !== Boolean(privateKeyPem.trim())
    || (httpsNeedsPem && (!certificatePem.trim() || !privateKeyPem.trim()))
  );
  const submit = () => {
    setError(null);
    if (!wildcardDomain.trim()) {
      setError('请输入通配域名');
      return;
    }
    if (httpsPemIncomplete) {
      setError('启用 HTTPS 时请同时提供证书和私钥 PEM');
      return;
    }
    if (!pool) {
      const parsed = zCreateHttpDomainPoolRequest.safeParse({
        wildcardDomain: wildcardDomain.trim(),
        enabled,
        httpsEnabled,
        certificatePem: certificatePem.trim() || null,
        privateKeyPem: privateKeyPem.trim() || null,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查域名池参数');
        return;
      }
      create.mutate(parsed.data);
      return;
    }
    const body: PatchHttpDomainPoolRequest = {
      wildcardDomain: wildcardDomain.trim(),
      enabled,
      httpsEnabled,
    };
    if (certificatePem.trim()) body.certificatePem = certificatePem.trim();
    if (privateKeyPem.trim()) body.privateKeyPem = privateKeyPem.trim();
    const parsed = zPatchHttpDomainPoolRequest.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查域名池参数');
      return;
    }
    patch.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="http-domain-pool-form">
        <DialogHeader>
          <DialogTitle>{pool ? '编辑域名池' : '新建域名池'}</DialogTitle>
          <DialogDescription>
            通配域名形如 *.example.com。HTTPS 开启后再填写证书。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField id="http-pool-wildcard" label="通配域名">
            <Input
              id="http-pool-wildcard"
              className="font-mono"
              value={wildcardDomain}
              placeholder="*.example.com"
              onChange={(event) => { setWildcardDomain(event.target.value); setError(null); }}
            />
          </FormField>
          <FormField id="http-pool-enabled" label="启用" orientation="inline">
            <Switch id="http-pool-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </FormField>
          <FormField id="http-pool-https" label="启用 HTTPS" orientation="inline">
            <Switch id="http-pool-https" checked={httpsEnabled} onCheckedChange={setHttpsEnabled} />
          </FormField>
          {httpsPemIncomplete && (
            <p className="text-xs text-destructive">启用 HTTPS 时请同时提供证书和私钥 PEM。</p>
          )}
          {pool?.certificateFingerprint ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>当前证书指纹：</span>
              <TechnicalId label="证书指纹" value={pool.certificateFingerprint} kind="opaque" />
            </div>
          ) : null}
          {httpsEnabled && (
            <>
              <FormField id="http-pool-cert" label="证书 PEM">
                <Textarea
                  id="http-pool-cert"
                  className="max-h-32 min-h-24 overflow-y-auto font-mono text-xs"
                  value={certificatePem}
                  placeholder={pool ? '留空则保留现有证书' : '-----BEGIN CERTIFICATE-----'}
                  onChange={(event) => { setCertificatePem(event.target.value); setError(null); }}
                />
              </FormField>
              <FormField id="http-pool-key" label="私钥 PEM">
                <Textarea
                  id="http-pool-key"
                  className="max-h-32 min-h-24 overflow-y-auto font-mono text-xs"
                  value={privateKeyPem}
                  placeholder={pool ? '留空则保留现有私钥' : '-----BEGIN PRIVATE KEY-----'}
                  onChange={(event) => { setPrivateKeyPem(event.target.value); setError(null); }}
                />
              </FormField>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={create.isPending || patch.isPending || httpsPemIncomplete}>
            {create.isPending || patch.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

