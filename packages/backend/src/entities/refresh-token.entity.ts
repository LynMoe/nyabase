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

  @Column('datetime')
  expiresAt: Date;

  @Column({ type: 'boolean', default: false })
  revoked: boolean;

  @Column('datetime')
  createdAt: Date;
}
