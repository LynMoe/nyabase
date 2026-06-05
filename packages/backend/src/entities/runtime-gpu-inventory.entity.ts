import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('runtime_gpu_inventory')
export class RuntimeGpuInventoryEntity {
  @PrimaryColumn({ name: 'server_id', type: 'text' })
  serverId: string;

  @PrimaryColumn({ name: 'gpu_index', type: 'int' })
  gpuIndex: number;

  @Column('text')
  uuid: string;

  @Column('text')
  model: string;

  @Column({ name: 'total_mem_mib', type: 'int' })
  totalMemMib: number;

  @Index()
  @Column({ name: 'observed_at', type: 'datetime' })
  observedAt: Date;
}
