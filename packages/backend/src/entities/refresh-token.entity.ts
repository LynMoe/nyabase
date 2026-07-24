import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('refresh_tokens')
export class RefreshTokenEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  userId: string;

  @Column({ type: 'text', unique: true })
  hash: string;

  /**
   * One-step predecessor retained for logout-after-rotation and for the exact
   * same high-entropy request-id recovery of a lost successful response. It is
   * never accepted as a general refresh or under a different request id.
   */
  @Index({ unique: true })
  @Column({ type: 'text', nullable: true })
  previousHash: string | null;

  /**
   * Hash of the high-entropy client request id that produced `hash` from
   * `previousHash`. It allows exactly that lost-response retry to recover the
   * same successor without accepting the predecessor as a general refresh.
   */
  @Column({ type: 'text', nullable: true })
  previousRequestIdHash: string | null;

  @Column('datetime')
  expiresAt: Date;

  @Column({ type: 'boolean', default: false })
  revoked: boolean;

  @Column('datetime')
  createdAt: Date;
}
