import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { numericTextTransformer } from './entity-transformers.js';

@Entity('quota_desired')
@Unique(['serverId', 'userId'])
export class QuotaDesiredEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column('text')
  userId: string;

  @Column({ type: 'int', nullable: true })
  numericUserId: number | null;

  @Column({ type: 'text', default: '0', transformer: numericTextTransformer })
  limitBytes: number;

  @Column({ type: 'text', default: 'grant' })
  source: string;

  @Column({ type: 'int', default: 1 })
  generation: number;

  @Column({ type: 'text', nullable: true })
  lastOperationId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
