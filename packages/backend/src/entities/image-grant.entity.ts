import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  Unique,
  CreateDateColumn,
} from 'typeorm';

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
  @Column('text')
  imageId: string;

  @Index()
  @Column('text')
  serverId: string;

  @CreateDateColumn()
  createdAt: Date;
}
