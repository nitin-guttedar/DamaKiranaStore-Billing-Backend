import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';

let dbInstance = null;
let savepointDepth = 0;

export function getDb() {
  if (dbInstance) return dbInstance;

  // Ensure data directory exists
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const rawDb = new DatabaseSync(config.dbPath);

  // Performance and safety pragmas
  rawDb.exec('PRAGMA foreign_keys = ON;');
  rawDb.exec('PRAGMA journal_mode = WAL;');
  rawDb.exec('PRAGMA synchronous = NORMAL;');
  rawDb.exec('PRAGMA busy_timeout = 5000;');

  dbInstance = {
    raw: rawDb,

    exec(sql) {
      return rawDb.exec(sql);
    },

    prepare(sql) {
      return rawDb.prepare(sql);
    },

    query(sql, params = []) {
      const stmt = rawDb.prepare(sql);
      return stmt.all(...params);
    },

    get(sql, params = []) {
      const stmt = rawDb.prepare(sql);
      return stmt.get(...params);
    },

    run(sql, params = []) {
      const stmt = rawDb.prepare(sql);
      return stmt.run(...params);
    },

    transaction(fn) {
      if (savepointDepth === 0) {
        rawDb.exec('BEGIN IMMEDIATE;');
        savepointDepth++;
        try {
          const result = fn(this);
          rawDb.exec('COMMIT;');
          savepointDepth--;
          return result;
        } catch (err) {
          rawDb.exec('ROLLBACK;');
          savepointDepth = 0;
          throw err;
        }
      } else {
        // Nested transaction using SQLite SAVEPOINT
        const spName = `sp_${savepointDepth++}`;
        rawDb.exec(`SAVEPOINT ${spName};`);
        try {
          const result = fn(this);
          rawDb.exec(`RELEASE SAVEPOINT ${spName};`);
          savepointDepth--;
          return result;
        } catch (err) {
          rawDb.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
          savepointDepth--;
          throw err;
        }
      }
    },

    close() {
      if (rawDb) {
        rawDb.close();
        dbInstance = null;
      }
    }
  };

  return dbInstance;
}

export default getDb;
