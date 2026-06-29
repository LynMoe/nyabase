import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('http_domain_pools')
export class HttpDomainPoolEntity {
  @PrimaryColumn('text')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'wildcard_domain', type: 'text' })
  wildcardDomain: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'https_enabled', type: 'boolean', default: false })
  httpsEnabled: boolean;

  @Column({ name: 'certificate_pem', type: 'text', nullable: true })
  certificatePem: string | null;

  @Column({ name: 'encrypted_private_key_pem', type: 'text', nullable: true })
  encryptedPrivateKeyPem: string | null;

  @Column({ name: 'certificate_fingerprint', type: 'text', nullable: true })
  certificateFingerprint: string | null;

  @Column({ name: 'certificate_not_after', type: 'datetime', nullable: true })
  certificateNotAfter: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
