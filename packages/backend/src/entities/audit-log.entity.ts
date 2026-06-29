import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { AuditAction } from '@nyabase/common';

@Entity('audit_logs')
export class AuditLogEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  actorId: string | null;

  @Column({ type: 'text', nullable: true })
  actorName: string | null;

  @Column({ type: 'text', nullable: true })
  actorUsername: string | null;

  @Column({ type: 'simple-json', nullable: true })
  actorSnapshot: unknown;

  @Column('text')
  action: AuditAction;

  @Column({ type: 'text', nullable: true })
  targetId: string | null;

  @Column({ type: 'text', nullable: true })
  targetType: string | null;

  @Column({ type: 'text', nullable: true })
  targetName: string | null;

  @Column({ type: 'simple-json', nullable: true })
  targetSnapshot: unknown;

  @Column({ type: 'simple-json', nullable: true })
  related: unknown;

  @Column({ type: 'simple-json', nullable: true })
  payload: unknown;

  @Index()
  @Column('datetime')
  ts: Date;
}
