import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { nullableNumericTextTransformer } from './entity-transformers.js';

export type RemoteFsRuntimeStatus = 'mounted' | 'mounting' | 'missing' | 'error' | 'unknown';

@Entity('remote_fs_runtime_observations')
@Unique(['serverId', 'remoteFsMountId', 'reportSeq'])
export class RemoteFsRuntimeObservationEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column('text')
  remoteFsMountId: string;

  @Column('text')
  hostMountPoint: string;

  @Index()
  @Column({ type: 'text', default: 'unknown' })
  status: RemoteFsRuntimeStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'text', nullable: true, transformer: nullableNumericTextTransformer })
  totalBytes: number | null;

  @Column({ type: 'text', nullable: true, transformer: nullableNumericTextTransformer })
  usedBytes: number | null;

  @Column({ type: 'int', default: 0 })
  reportSeq: number;

  @Index()
  @Column('datetime')
  lastSeenAt: Date;

  @Index()
  @Column({ type: 'boolean', default: false })
  stale: boolean;
}
