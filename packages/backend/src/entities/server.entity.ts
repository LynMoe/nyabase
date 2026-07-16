import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import { ServerStatus } from '@nyabase/common';

export const AGENT_INVENTORY_FAULT_QUARANTINE_CODE = 'AGENT_INVENTORY_FAULT';
export const AGENT_TASK_FAIL_STOP_QUARANTINE_CODE = 'AGENT_TASK_FAIL_STOP';

@Entity('servers')
export class ServerEntity {
  @PrimaryColumn('text')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  slug: string;

  // Looked up on every agent WS handshake; unique per server (one token per server).
  @Index({ unique: true })
  @Column('text')
  agentTokenHash: string;

  /** Bound on the first authenticated hello and immutable thereafter. */
  @Index({ unique: true })
  @Column({ type: 'text', nullable: true })
  hostFingerprint: string | null;

  /** Immutable semantic fingerprint of all static physical addressing config. */
  @Column({ type: 'text', nullable: true })
  agentConfigFingerprint: string | null;

  @Column({ type: 'text', default: ServerStatus.Unknown })
  status: ServerStatus;

  @Index('IDX_servers_quarantine_code')
  @Column({ name: 'quarantine_code', type: 'text', nullable: true })
  quarantineCode: string | null;

  @Column({ name: 'quarantine_message', type: 'text', nullable: true })
  quarantineMessage: string | null;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt: Date | null;

  @Column({ name: 'macvlan_cidr', type: 'text', nullable: true })
  macvlanCidr: string | null;

  @Column({ name: 'macvlan_gateway', type: 'text', nullable: true })
  macvlanGateway: string | null;

  @Column({ name: 'macvlan_reserved_ips', type: 'simple-json', default: '[]' })
  macvlanReservedIps: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
