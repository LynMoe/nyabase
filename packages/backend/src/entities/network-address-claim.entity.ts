import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { ServerEntity } from './server.entity.js';

export type NetworkAddressOwnerKind =
  | 'gateway'
  | 'host'
  | 'container'
  | 'runtime_cleanup';
export type NetworkAddressClaimState = 'active' | 'releasing';

/**
 * Unified durable authority for every physical IPv4 claimant. Multiple active
 * rows for one address intentionally represent an observed physical conflict;
 * allocation and proxy routing both fail closed until exact cleanup succeeds.
 */
@Entity('network_address_claims')
@Unique('UQ_network_address_claim_owner', ['ownerKind', 'ownerId', 'serverId', 'address'])
@Check(
  'CHK_network_address_claim_owner_shape',
  `(("owner_kind" IN ('container', 'runtime_cleanup') AND "server_id" IS NOT NULL)
    OR ("owner_kind" IN ('gateway', 'host') AND "server_id" IS NULL))`,
)
@Check(
  'CHK_network_address_claim_state_shape',
  `(("state" = 'active' AND "reusable_at" IS NULL)
    OR ("state" = 'releasing' AND "reusable_at" IS NOT NULL))`,
)
@Check(
  'CHK_network_address_claim_cleanup_evidence',
  `(("owner_kind" = 'runtime_cleanup' AND "cleanup_payload_json" IS NOT NULL)
    OR ("owner_kind" <> 'runtime_cleanup' AND "cleanup_payload_json" IS NULL))`,
)
export class NetworkAddressClaimEntity {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Index()
  @Column({ type: 'text' })
  address: string;

  @Index()
  @Column({ name: 'network_key', type: 'text' })
  networkKey: string;

  @Index()
  @Column({ name: 'owner_kind', type: 'text' })
  ownerKind: NetworkAddressOwnerKind;

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'server_id', type: 'text', nullable: true })
  serverId: string | null;

  @Column({ type: 'text', default: 'active' })
  state: NetworkAddressClaimState;

  /** Immutable Agent payload used to verify/scrub an absent residual runtime. */
  @Column({ name: 'cleanup_payload_json', type: 'simple-json', nullable: true })
  cleanupPayloadJson: unknown | null;

  @Index()
  @Column({ name: 'reusable_at', type: 'datetime', nullable: true })
  reusableAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
