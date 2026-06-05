import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { ContainerPowerIntent } from '@nyabase/common';
import type { ImageRuntimeOverrides } from '@nyabase/common';
import { numericTextTransformer } from './entity-transformers.js';

export type ContainerGpuMode = 'none' | 'indices' | 'all';

@Entity('container_desired_specs')
@Unique(['containerId'])
export class ContainerDesiredSpecEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ name: 'container_id', type: 'text' })
  containerId: string;

  @Column({ type: 'int', default: 1 })
  generation: number;

  @Column({ name: 'image_ref', type: 'text' })
  imageRef: string;

  @Column({ name: 'image_default_uid', type: 'int', default: 0 })
  imageDefaultUid: number;

  @Column({
    name: 'image_runtime_overrides',
    type: 'simple-json',
    default: '{"uid":0,"entrypoint":null,"cmd":null,"init":false}',
  })
  imageRuntimeOverrides: ImageRuntimeOverrides;

  @Column({ name: 'cpu_millis', type: 'int', default: 0 })
  cpuMillis: number;

  @Column({ name: 'mem_bytes', type: 'text', default: '0', transformer: numericTextTransformer })
  memBytes: number;

  @Column({ name: 'disk_bytes', type: 'text', default: '0', transformer: numericTextTransformer })
  diskBytes: number;

  @Column({ name: 'gpu_mode', type: 'text', default: 'none' })
  gpuMode: ContainerGpuMode;

  @Column({ name: 'gpu_indices', type: 'simple-json', default: '[]' })
  gpuIndices: number[];

  @Column({ name: 'mounts_json', type: 'simple-json', default: '[]' })
  mountsJson: unknown;

  @Column({ name: 'ssh_enabled', type: 'boolean', default: false })
  sshEnabled: boolean;

  @Index()
  @Column({ name: 'power_intent', type: 'text', default: ContainerPowerIntent.Running })
  powerIntent: ContainerPowerIntent;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
