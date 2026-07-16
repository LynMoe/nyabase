import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { ContainerEntity } from './container.entity.js';
import { ServerEntity } from './server.entity.js';

@Entity('gpu_allocations')
export class GpuAllocationEntity {
  @PrimaryColumn({ name: 'container_id', type: 'text' })
  @ForeignKey(() => ContainerEntity, { onDelete: 'CASCADE' })
  containerId: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Column({ name: 'gpu_indices_json', type: 'simple-json', default: '[]' })
  gpuIndicesJson: number[];

  @Column({ name: 'allocated_at', type: 'datetime' })
  allocatedAt: Date;
}
