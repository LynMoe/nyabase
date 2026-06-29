import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('ssh_proxy_tokens')
export class SshProxyTokenEntity {
  @PrimaryColumn({ type: 'text' })
  id: 'singleton';

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @Column({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}
