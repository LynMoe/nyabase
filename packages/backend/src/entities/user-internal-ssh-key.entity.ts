import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('user_internal_ssh_keys')
export class UserInternalSshKeyEntity {
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'encrypted_private_key', type: 'text' })
  encryptedPrivateKey: string;

  @Column({ name: 'public_key', type: 'text' })
  publicKey: string;

  @Index()
  @Column({ type: 'text' })
  fingerprint: string;

  @Column({ type: 'int', default: 1 })
  generation: number;

  @Column({ name: 'rotated_at', type: 'datetime' })
  rotatedAt: Date;
}
