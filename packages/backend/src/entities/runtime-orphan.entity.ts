import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

export type RuntimeOrphanReason = 'missing_label' | 'desired_missing' | 'unknown_owner' | 'stale_generation';

@Entity('runtime_orphans')
@Unique(['serverId', 'runtimeId'])
export class RuntimeOrphanEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Index()
  @Column({ name: 'runtime_id', type: 'text' })
  runtimeId: string;

  @Index()
  @Column('text')
  reason: RuntimeOrphanReason;

  @Column({ name: 'labels_json', type: 'simple-json', default: '{}' })
  labelsJson: Record<string, string>;

  @Index()
  @Column({ name: 'observed_at', type: 'datetime' })
  observedAt: Date;

  @Column({ name: 'cleanup_hint_json', type: 'simple-json', default: '{}' })
  cleanupHintJson: unknown;
}
