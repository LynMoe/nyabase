import { Module } from '@nestjs/common';
import { PgPersistenceModule } from '../persistence-pg/persistence-pg.module.js';

@Module({
  imports: [PgPersistenceModule],
  exports: [PgPersistenceModule],
})
export class DatabaseModule {}
