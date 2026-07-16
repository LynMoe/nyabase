import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { ImageEntity } from './image.entity.js';
import { ServerEntity } from './server.entity.js';

@Entity('containers')
@Index('UQ_containers_owner_server_name', ['ownerId', 'serverId', 'name'], {
  unique: true,
})
export class ContainerEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Index()
  @Column('text')
  name: string;

  @ForeignKey(() => ImageEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'image_id', type: 'text' })
  imageId: string;

  @Index()
  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

}
