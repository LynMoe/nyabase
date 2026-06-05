import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import { ServerStatus, GpuGrantMode } from '@nyabase/common';

// TypeORM may call `from` with an already-transformed JS value in some hydration paths
// (e.g. after create+save). Guard each transformer against that.

/** Stores a bigint-safe number as text in SQLite while exposing it as `number` in TypeScript. */
const numericTextTransformer = {
  to: (v: number): string => String(v ?? 0),
  from: (v: string | number): number => {
    if (typeof v === 'number') return v;
    return parseInt(v ?? '0', 10);
  },
};

/** Stores a string[] as a JSON array in SQLite. Handles legacy comma-separated data. */
const stringArrayTransformer = {
  to: (v: string[]): string => JSON.stringify(Array.isArray(v) ? v : []),
  from: (v: string | string[]): string[] => {
    if (Array.isArray(v)) return v;
    if (!v || v === '') return [];
    try { return JSON.parse(v) as string[]; }
    catch { return (v as string).split(',').filter(Boolean); }
  },
};

/** Stores a number[] as a JSON array in SQLite. */
const numberArrayTransformer = {
  to: (v: number[]): string => JSON.stringify(Array.isArray(v) ? v : []),
  from: (v: string | number[]): number[] => {
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v as string) as number[]; }
    catch { return []; }
  },
};

@Entity('servers')
export class ServerEntity {
  @PrimaryColumn('text')
  id: string;

  @Column({ type: 'text', unique: true })
  name: string;

  @Column('text')
  parentIface: string;

  @Column('text')
  ipCidr: string;

  @Column('text')
  gateway: string;

  // Looked up on every agent WS handshake; unique per server (one token per server).
  @Index({ unique: true })
  @Column('text')
  agentTokenHash: string;

  @Column({ type: 'text', default: '[]', transformer: stringArrayTransformer })
  reservedIps: string[];

  @Column({ type: 'boolean', default: true })
  isGpuServer: boolean;

  @Column({ type: 'text', default: ServerStatus.Unknown })
  status: ServerStatus;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt: Date | null;

  /**
   * Frozen on first agent hello. Set by AgentGateway; never updated afterwards.
   * Stored here so it survives agent restarts without needing agent to be online.
   */
  @Column({ type: 'text', nullable: true })
  dockerRoot: string | null;

  @Column({ type: 'text', nullable: true })
  dockerSocket: string | null;

  // --- Resource defaults (applied when a grant leaves a field null) ---

  @Column({ type: 'int', default: 0 })
  defaultCpuMillis: number;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  defaultMemBytes: number;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  defaultDiskBytes: number;

  @Column({ type: 'text', default: GpuGrantMode.None })
  defaultGpuMode: GpuGrantMode;

  @Column({ type: 'text', default: '[]', transformer: numberArrayTransformer })
  defaultGpuIndices: number[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
