import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ServerEntity } from './server.entity.js';

@Entity('mount_source_grants')
@Check(
  'CHK_mount_source_grants_shape',
  `("sourceKind" = 'local' AND "serverId" IS NOT NULL AND "sourceIdentity" IS NOT NULL AND length(trim("sourceIdentity")) > 0)
    OR ("sourceKind" = 'remote' AND "serverId" IS NULL AND "sourceIdentity" IS NULL)`,
)
@Check('CHK_mount_source_grants_scope', `"scope" IN ('user', 'group')`)
@Index(
  'UQ_mount_source_grants_remote',
  ['scope', 'scopeId', 'sourceKind', 'sourceId'],
  { unique: true, where: `"sourceKind" = 'remote'` },
)
@Index(
  'UQ_mount_source_grants_local',
  ['scope', 'scopeId', 'sourceKind', 'sourceId', 'serverId', 'sourceIdentity'],
  { unique: true, where: `"sourceKind" = 'local'` },
)
export class MountSourceGrantEntity {
  @PrimaryColumn('text')
  id: string;

  /** 'user' or 'group' */
  @Index()
  @Column('text')
  scope: 'user' | 'group';

  @Index()
  @Column('text')
  scopeId: string;

  /** 'local' (dataDisk) or 'remote' (remoteFsMount) */
  @Column('text')
  sourceKind: 'local' | 'remote';

  /** dataDiskId or remoteFsMountId — no FK, cascade-deleted by service layer */
  @Index()
  @Column('text')
  sourceId: string;

  /** Exact server that reported a local disk. Remote grants must keep this null. */
  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column({ type: 'text', nullable: true })
  serverId: string | null;

  /** Immutable physical identity reported by the Agent for a local disk. */
  @Column({ type: 'text', nullable: true })
  sourceIdentity: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
