import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('ssh_proxy_host_keys')
export class SshProxyHostKeyEntity {
  @PrimaryColumn({ type: 'text' })
  id: 'singleton';

  @Column({ name: 'encrypted_private_key', type: 'text' })
  encryptedPrivateKey: string;

  @Column({ name: 'public_key', type: 'text' })
  publicKey: string;

  @Column({ type: 'text' })
  fingerprint: string;

  @Column({ type: 'int', default: 1 })
  generation: number;

  @Column({ name: 'rotated_at', type: 'datetime' })
  rotatedAt: Date;
}
