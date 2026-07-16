import {
  Column, CreateDateColumn, Entity, ForeignKey, Index, PrimaryColumn, UpdateDateColumn,
} from 'typeorm';
import { ContainerEntity } from './container.entity.js';
import { HttpDomainPoolEntity } from './http-domain-pool.entity.js';

@Entity('http_proxy_bindings')
export class HttpProxyBindingEntity {
  @PrimaryColumn('text')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  hostname: string;

  @Index()
  @ForeignKey(() => HttpDomainPoolEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'domain_pool_id', type: 'text' })
  domainPoolId: string;

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Index()
  @ForeignKey(() => ContainerEntity, { onDelete: 'CASCADE' })
  @Column({ name: 'container_id', type: 'text' })
  containerId: string;

  @Column({ name: 'target_port', type: 'int' })
  targetPort: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
