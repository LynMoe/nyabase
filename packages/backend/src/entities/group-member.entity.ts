import { Entity, PrimaryColumn, Column, Index, Unique } from 'typeorm';

@Entity('group_members')
@Unique(['groupId', 'userId'])
export class GroupMemberEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  groupId: string;

  @Index()
  @Column('text')
  userId: string;
}
