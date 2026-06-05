import {
  Entity, PrimaryColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('mount_source_grants')
@Unique(['scope', 'scopeId', 'sourceKind', 'sourceId'])
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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
