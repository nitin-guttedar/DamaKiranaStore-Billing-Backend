import fs from 'fs';
import path from 'path';
import { getDb } from '../server/src/db/index.js';
import { config } from '../server/src/config/index.js';

async function performBackup() {
  console.log('--- KiranaOS Database Backup Tool ---');
  const db = getDb();

  // 1. Flush WAL pages to disk
  console.log('[*] Checkpointing SQLite WAL...');
  db.exec('PRAGMA wal_checkpoint(FULL);');

  // 2. Run integrity check
  const check = db.get('PRAGMA integrity_check;');
  if (check.integrity_check !== 'ok') {
    throw new Error(`Integrity check failed: ${check.integrity_check}`);
  }
  console.log('[+] Database integrity verified: OK');

  // 3. Create timestamped backup
  const backupDir = path.resolve(path.dirname(config.dbPath), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `kiranaos_backup_${timestamp}.db`);

  fs.copyFileSync(config.dbPath, backupFile);
  const stats = fs.statSync(backupFile);

  console.log('========================================================');
  console.log(` Backup Created Successfully!`);
  console.log(` File: ${backupFile}`);
  console.log(` Size: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log('========================================================');
}

performBackup().then(() => process.exit(0)).catch(err => {
  console.error('[!] Backup failed:', err);
  process.exit(1);
});
