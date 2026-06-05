import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('runtime_container_stats')
export class RuntimeContainerStatEntity {
  @PrimaryColumn({ name: 'runtime_container_id', type: 'text' })
  runtimeContainerId: string;

  @Column({ name: 'stats_json', type: 'simple-json' })
  statsJson: unknown;

  @Column({ name: 'observed_at', type: 'datetime' })
  observedAt: Date;
}
