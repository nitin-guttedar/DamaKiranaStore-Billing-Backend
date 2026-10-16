import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';

let DatabaseSync;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSync = sqlite.DatabaseSync;
} catch (e) {
  console.warn('[KiranaOS DB] Native node:sqlite not available in runtime:', process.version);
}

let dbInstance = null;
let savepointDepth = 0;

export function getDb() {
  if (dbInstance) return dbInstance;

  if (!DatabaseSync) {
    console.error(`[KiranaOS DB] DatabaseSync is unavailable in Node ${process.version}. Node.js 22.x is required.`);
    // Return a safe mock/stub interface so startup and status routes never crash
    return {
      raw: null,
      exec() {},
      prepare() {
        return {
          all: () => [],
          get: () => null,
          run: () => ({ changes: 0 })
        };
      },
      query() { return []; },
      get() { return null; },
      run() { return { changes: 0 }; },
      transaction(fn) { return fn(this); },
      close() {}
    };
  }

  // Ensure data directory exists
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const rawDb = new DatabaseSync(config.dbPath);

  // Performance and safety pragmas
  rawDb.exec('PRAGMA foreign_keys = ON;');
  rawDb.exec('PRAGMA synchronous = NORMAL;');
  rawDb.exec('PRAGMA busy_timeout = 5000;');

  if (!process.env.VERCEL) {
    rawDb.exec('PRAGMA journal_mode = WAL;');
  }

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
