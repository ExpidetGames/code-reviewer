// SPDX-License-Identifier: Apache-2.0

// Kysely's SQLite dialect with two changes that the stock one lacks:
//
// 1. Transactions start with `begin immediate`. A deferred transaction that reads first and writes
//    later fails with SQLITE_BUSY_SNAPSHOT (no busy timeout applies) when another connection wrote in
//    between. Taking the write lock up front makes the busy timeout apply and serializes writers.
// 2. The adapter reports transactional DDL. SQLite does roll back schema changes, and only then does
//    Kysely's Migrator run all pending migrations inside one transaction. That is what makes a
//    failing migration leave no half-built table and lets two starting instances take turns.
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type DialectAdapter,
  type Driver,
  type SqliteDialectConfig,
} from "kysely";

class ImmediateTransactionDriver extends SqliteDriver {
  override async beginTransaction(
    connection: DatabaseConnection,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}

class TransactionalDdlAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

export class AppSqliteDialect extends SqliteDialect {
  private readonly driverConfig: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.driverConfig = config;
  }

  override createDriver(): Driver {
    return new ImmediateTransactionDriver(this.driverConfig);
  }

  override createAdapter(): DialectAdapter {
    return new TransactionalDdlAdapter();
  }
}
