import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

export type DataDirRuntimeIssueKind = 'missing' | 'orphan' | null;

@Entity('data_dir_runtime_observations')
@Unique(['serverId', 'sourceKind', 'sourceId', 'name', 'reportSeq'])
export class DataDirRuntimeObservationEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  dataDirId: string | null;

  @Column('text')
  sourceKind: 'local' | 'remote';

  @Index()
  @Column('text')
  sourceId: string;

  @Column('text')
  name: string;

  @Column({ type: 'text', nullable: true })
  hostPath: string | null;

  @Column({ type: 'text', nullable: true })
  userId: string | null;

  @Column({ type: 'int', default: 0 })
  reportSeq: number;

  @Column({ type: 'boolean', default: true })
  present: boolean;

  @Index()
  @Column({ type: 'text', nullable: true })
  issueKind: DataDirRuntimeIssueKind;

  @Column('datetime')
  firstSeenAt: Date;

  @Index()
  @Column('datetime')
  lastSeenAt: Date;

  @Column({ type: 'datetime', nullable: true })
  missingSince: Date | null;

  @Index()
  @Column({ type: 'boolean', default: false })
  stale: boolean;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}
