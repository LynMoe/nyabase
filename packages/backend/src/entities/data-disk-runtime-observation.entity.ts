import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { numericTextTransformer } from './entity-transformers.js';

@Entity('data_disk_runtime_observations')
@Unique(['serverId', 'diskId', 'reportSeq'])
export class DataDiskRuntimeObservationEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column('text')
  diskId: string;

  @Column('text')
  mountPoint: string;

  @Column({ type: 'text', nullable: true })
  label: string | null;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  totalBytes: number;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  usedBytes: number;

  @Column({ type: 'boolean', default: false })
  pquotaEnabled: boolean;

  @Column({ type: 'int', default: 0 })
  reportSeq: number;

  @Index()
  @Column('datetime')
  lastSeenAt: Date;

  @Index()
  @Column({ type: 'boolean', default: false })
  stale: boolean;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}
