import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Capability, SystemGroupKey } from '@nyabase/common';

@Entity('groups')
export class GroupEntity {
  @PrimaryColumn('text')
  id: string;

  @Column({ type: 'text', unique: true })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  /** Immutable built-in identity. Null for ordinary administrator-created groups. */
  @Column({ type: 'text', nullable: true, unique: true })
  systemKey: SystemGroupKey | null;

  /** JSON array of Capability values */
  @Column({ type: 'text', default: '[]' })
  capabilitiesJson: string;

  /** Durable optimistic-concurrency token for group metadata mutations. */
  @Column({ type: 'integer', default: 1 })
  revision: number;

  get capabilities(): Capability[] {
    return JSON.parse(this.capabilitiesJson) as Capability[];
  }

  set capabilities(caps: Capability[]) {
    this.capabilitiesJson = JSON.stringify(caps);
  }

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
