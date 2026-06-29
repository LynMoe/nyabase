import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { HttpProxyTargetProtocol } from '@nyabase/common';

@Entity('http_proxy_bindings')
export class HttpProxyBindingEntity {
  @PrimaryColumn('text')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  hostname: string;

  @Index()
  @Column({ name: 'domain_pool_id', type: 'text' })
  domainPoolId: string;

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Index()
  @Column({ name: 'container_id', type: 'text' })
  containerId: string;

  @Column({ name: 'target_port', type: 'int' })
  targetPort: number;

  @Column({ name: 'target_protocol', type: 'text', default: 'http' })
  targetProtocol: HttpProxyTargetProtocol;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
