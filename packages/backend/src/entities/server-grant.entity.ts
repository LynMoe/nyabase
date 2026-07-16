import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
  ForeignKey,
} from 'typeorm';
import { GpuGrantMode } from '@nyabase/common';
import { ServerEntity } from './server.entity.js';

/** Stores a nullable bigint-safe number as text in SQLite. */
const nullableNumericTextTransformer = {
  to: (v: number | null): string | null => (v === null ? null : String(v)),
  from: (v: string | number | null): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    return parseInt(v, 10);
  },
};

/** Stores a nullable number[] as a JSON array in SQLite. */
const nullableNumberArrayTransformer = {
  to: (v: number[] | null): string | null => (v === null ? null : JSON.stringify(v)),
  from: (v: string | number[] | null): number[] | null => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v as string) as number[]; }
    catch { return null; }
  },
};

@Entity('server_grants')
@Unique(['scope', 'scopeId', 'serverId'])
export class ServerGrantEntity {
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
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column('text')
  serverId: string;

  /** null → fall back to server default */
  @Column({ type: 'int', nullable: true })
  cpuMillis: number | null;

  /** Stored as text to avoid integer overflow; null → server default */
  @Column({ type: 'text', nullable: true, transformer: nullableNumericTextTransformer })
  memBytes: number | null;

  @Column({ type: 'text', nullable: true, transformer: nullableNumericTextTransformer })
  diskBytes: number | null;

  /** null → fall back to server default */
  @Column({ type: 'text', nullable: true, default: null })
  gpuMode: GpuGrantMode | null;

  /** null → not applicable */
  @Column({ type: 'text', nullable: true, transformer: nullableNumberArrayTransformer })
  gpuIndices: number[] | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
