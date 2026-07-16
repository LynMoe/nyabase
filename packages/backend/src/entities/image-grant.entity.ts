import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  Unique,
  CreateDateColumn,
  ForeignKey,
} from 'typeorm';
import { ImageEntity } from './image.entity.js';
import { ServerEntity } from './server.entity.js';

@Entity('image_grants')
@Unique(['scope', 'scopeId', 'imageId', 'serverId'])
export class ImageGrantEntity {
  @PrimaryColumn('text')
  id: string;

  /** 'group' or 'user' */
  @Index()
  @Column('text')
  scope: 'group' | 'user';

  @Index()
  @Column('text')
  scopeId: string;

  @Index()
  @ForeignKey(() => ImageEntity, { onDelete: 'RESTRICT' })
  @Column('text')
  imageId: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column('text')
  serverId: string;

  @CreateDateColumn()
  createdAt: Date;
}
