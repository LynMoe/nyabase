import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { numericTextTransformer } from './entity-transformers.js';

@Entity('quota_runtime_observations')
@Unique(['serverId', 'numericUserId', 'projectId', 'reportSeq'])
export class QuotaRuntimeObservationEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  userId: string | null;

  @Index()
  @Column({ type: 'int' })
  numericUserId: number;

  @Column({ type: 'int' })
  projectId: number;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  usedBytes: number;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  hardLimitBytes: number;

  @Column({ type: 'int', default: 0 })
  reportSeq: number;

  @Index()
  @Column('datetime')
  lastSeenAt: Date;

  @Index()
  @Column({ type: 'boolean', default: false })
  stale: boolean;

  @Column({ type: 'simple-json', nullable: true })
  drift: unknown | null;
}
