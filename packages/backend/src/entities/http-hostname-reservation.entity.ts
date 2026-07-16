import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type HttpHostnameReservationState = 'active' | 'releasing';

@Entity('http_hostname_reservations')
export class HttpHostnameReservationEntity {
  @PrimaryColumn({ type: 'text' })
  hostname: string;

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Index()
  @Column({ name: 'binding_id', type: 'text', nullable: true })
  bindingId: string | null;

  @Column({ type: 'text', default: 'active' })
  state: HttpHostnameReservationState;

  @Index()
  @Column({ name: 'reusable_at', type: 'datetime', nullable: true })
  reusableAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
