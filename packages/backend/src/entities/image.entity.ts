import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ImageRuntimeOverrides } from '@nyabase/common';

@Entity('images')
export class ImageEntity {
  @PrimaryColumn('text')
  id: string;

  @Column({ type: 'text', unique: true })
  name: string;

  @Column('text')
  dockerImage: string;

  @Column({ type: 'int', default: 0 })
  defaultUid: number;

  @Column({
    name: 'runtime_overrides',
    type: 'simple-json',
    default: '{"uid":0,"entrypoint":null,"cmd":null,"init":false}',
  })
  runtimeOverrides: ImageRuntimeOverrides;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'disable_ssh', type: 'boolean', default: false })
  disableSsh: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
