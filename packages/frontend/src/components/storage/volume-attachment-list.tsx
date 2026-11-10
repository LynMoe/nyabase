import type { ListScope, VolumeAttachmentSummaryDto } from '@nyabase/common';
import { ResourceRef } from '../refs/resource-ref.js';

/** 挂载于 …: each container links to its detail page on the surface `scope` names. */
export function VolumeAttachmentList({
  attachments,
  scope,
  testId,
}: {
  attachments: readonly VolumeAttachmentSummaryDto[];
  scope: ListScope;
  testId: string;
}) {
  if (attachments.length === 0) return <span className="text-muted-foreground">未挂载</span>;
  return (
    <span data-testid={testId}>
      挂载于{' '}
      {attachments.map((item, index) => (
        <span key={item.attachmentId}>
          {index > 0 ? '、' : null}
          <ResourceRef kind="container" id={item.containerId} name={item.containerName} scope={scope} />
          <span className="text-muted-foreground">（{item.containerPath}）</span>
        </span>
      ))}
    </span>
  );
}
