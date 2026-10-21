import { Link } from '@tanstack/react-router';
import type { ServerDto } from '@nyabase/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Field } from '../../components/layout/field.js';
import { ConnectCard } from '../../components/servers/connect-card.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { preflightStatusLabel, storageOvercommitLabel } from '../../lib/display-labels.js';

export function ServerOverviewTab({
  server,
  registeredPoolCount,
  onSelectTab,
}: {
  server: ServerDto;
  registeredPoolCount: number;
  onSelectTab: (tab: 'connect' | 'storage' | 'preflight') => void;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">身份</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="slug" value={<TechnicalId label="slug" value={server.slug} kind="text" />} />
          <Field label="接入地址" value={<TechnicalId label="接入地址" value={server.apiEndpoint} kind="text" />} />
          <Field label="Incus 版本" value={server.incusVersion ?? '未连接'} />
          <Field label="系统盘池" value={server.systemPoolName ?? server.systemPoolId ?? '未指定'} />
          <Field label="存储超分比例" value={storageOvercommitLabel(server.storageOvercommitRatio)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">接入清单</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>
              <button type="button" className="underline" onClick={() => onSelectTab('connect')}>互信</button>
              {server.incusVersion || server.serverCertFingerprint ? ' · 已连接' : ' · 未连接'}
            </li>
            <li>
              <button type="button" className="underline" onClick={() => onSelectTab('storage')}>存储池</button>
              {` · 已登记 ${registeredPoolCount} 个`}
            </li>
            <li>
              <button type="button" className="underline" onClick={() => onSelectTab('preflight')}>前置检查</button>
              {` · ${preflightStatusLabel(server.preflightStatus)}`}
            </li>
            <li>
              <Link to="/ip-pools" className="underline">IP 池</Link>
              {' · 在 IP 池页把地址段绑定到这台服务器'}
            </li>
          </ol>
        </CardContent>
      </Card>
    </>
  );
}

export function ServerConnectTab({
  server,
  trustToken,
  expectedFingerprint,
  connectPending,
  onTrustTokenChange,
  onExpectedFingerprintChange,
  onConnect,
}: {
  server: ServerDto;
  trustToken: string;
  expectedFingerprint: string;
  connectPending: boolean;
  onTrustTokenChange: (value: string) => void;
  onExpectedFingerprintChange: (value: string) => void;
  onConnect: () => void;
}) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <ConnectCard
        server={server}
        trustToken={trustToken}
        expectedFingerprint={expectedFingerprint}
        connectPending={connectPending}
        onTrustTokenChange={onTrustTokenChange}
        onExpectedFingerprintChange={onExpectedFingerprintChange}
        onConnect={onConnect}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">客户端证书</CardTitle>
          <CardDescription>
            所有服务器共用一张自动生成的 Incus 客户端证书，在
            <Link to="/servers" hash="client-identity" className="mx-1 underline underline-offset-4">服务器列表</Link>
            查看指纹。
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
