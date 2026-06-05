import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('containers')
export class ContainerEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Index()
  @Column('text')
  name: string;

  @Column({ name: 'image_id', type: 'text' })
  imageId: string;

  @Index()
  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Index()
  @Column({ name: 'deleted_at', type: 'datetime', nullable: true })
  deletedAt: Date | null;
}
