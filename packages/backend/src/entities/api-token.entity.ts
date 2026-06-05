import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('api_tokens')
export class ApiTokenEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  userId: string;

  @Column('text')
  name: string;

  @Column({ type: 'text', unique: true })
  hash: string;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null;

  @Column('datetime')
  createdAt: Date;
}
