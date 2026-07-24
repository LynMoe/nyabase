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

  @Column({ type: 'text', unique: true })
  dockerImage: string;

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

  /** Retains canonical dockerImage ownership until every Agent proves absence. */
  @Column({ name: 'deleting', type: 'boolean', default: false })
  deleting: boolean;

  @Column({ name: 'cleanup_generation', type: 'integer', default: 0 })
  cleanupGeneration: number;

  /** Durable optimistic-concurrency token for every retained row mutation. */
  @Column({ type: 'integer', default: 1 })
  revision: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
