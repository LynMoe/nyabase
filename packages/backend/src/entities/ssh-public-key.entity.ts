import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('ssh_public_keys')
export class SshPublicKeyEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  userId: string;

  @Column('text')
  name: string;

  @Column('text')
  keyText: string;

  @Column('datetime')
  createdAt: Date;
}
