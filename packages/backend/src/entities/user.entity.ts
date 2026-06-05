import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserStatus } from '@nyabase/common';

@Entity('users')
export class UserEntity {
  @PrimaryColumn('text')
  id: string;

  /** Stable auto-increment integer used by agents to compute XFS project IDs. */
  @Column({ type: 'int', unique: true, nullable: true })
  numericId: number;

  @Column({ type: 'text', unique: true })
  username: string;

  @Column('text')
  passwordHash: string;

  @Column('text')
  displayName: string;

  @Column({ type: 'text', default: UserStatus.Active })
  status: UserStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
