import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('gpu_allocations')
export class GpuAllocationEntity {
  @PrimaryColumn({ name: 'container_id', type: 'text' })
  containerId: string;

  @Index()
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Column({ name: 'gpu_indices_json', type: 'simple-json', default: '[]' })
  gpuIndicesJson: number[];

  @Column({ name: 'allocated_at', type: 'datetime' })
  allocatedAt: Date;
}
