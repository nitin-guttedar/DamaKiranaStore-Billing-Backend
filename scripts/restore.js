import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/src/config/index.js';

async function performRestore() {
  console.log('--- KiranaOS Database Restore Tool ---');
  const backupFile = process.argv[2];

  if (!backupFile) {
    console.error('Usage: node scripts/restore.js <path-to-backup.db>');
    process.exit(1);
  }

  const resolvedBackup = path.resolve(backupFile);
  if (!fs.existsSync(resolvedBackup)) {
    console.error(`[!] Backup file does not exist: ${resolvedBackup}`);
    process.exit(1);
  }

  // 1. Verify backup file integrity before restoring
  console.log('[*] Testing backup integrity...');
  try {
    const testDb = new DatabaseSync(resolvedBackup);
    const check = testDb.prepare('PRAGMA integrity_check;').get();
    testDb.close();

    if (check.integrity_check !== 'ok') {
      throw new Error(`Backup file is corrupted: ${check.integrity_check}`);
    }
    console.log('[+] Backup file integrity verified: OK');
  } catch (err) {
    console.error('[!] Integrity check failed on backup:', err.message);
    process.exit(1);
  }

  // 2. Backup current active database before overwriting
  const currentDbPath = config.dbPath;
  if (fs.existsSync(currentDbPath)) {
    const safetyCopy = `${currentDbPath}.pre_restore_${Date.now()}`;
    console.log(`[*] Creating safety copy of current active database: ${safetyCopy}`);
    fs.copyFileSync(currentDbPath, safetyCopy);
  }

  // 3. Restore database file
  console.log(`[*] Overwriting ${currentDbPath} with backup file...`);
  fs.copyFileSync(resolvedBackup, currentDbPath);

  // Remove any stale WAL or SHM files
  const walFile = `${currentDbPath}-wal`;
  const shmFile = `${currentDbPath}-shm`;
  if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
  if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

  console.log('========================================================');
  console.log(' Database Restored Successfully!');
  console.log(` Restored from: ${resolvedBackup}`);
  console.log(` Active DB:     ${currentDbPath}`);
  console.log('========================================================');
}

performRestore().then(() => process.exit(0)).catch(err => {
  console.error('[!] Restore failed:', err);
  process.exit(1);
});
