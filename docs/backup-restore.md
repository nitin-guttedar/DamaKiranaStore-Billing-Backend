# KiranaOS — Database Backup & Disaster Recovery Runbook

KiranaOS relies on local SQLite in WAL (Write-Ahead Logging) mode. This document describes operational procedures for creating point-in-time backups, verifying database integrity, automating daily schedules, and performing safe disaster recovery.

---

## 1. Architecture & WAL Mode

KiranaOS initializes SQLite with:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

In WAL mode, reads never block writes, and writes never block reads. Active transactions are written to `kiranaos.db-wal` before being checkpointed back to the main `kiranaos.db` file.

---

## 2. Point-in-Time Backup Procedure

Never copy `kiranaos.db` while active write transactions are pending in the WAL without flushing. KiranaOS provides an automated backup script (`scripts/backup.js`) that performs a 3-step process:

1. **WAL Checkpoint**: Executes `PRAGMA wal_checkpoint(FULL);` to force all uncommitted WAL pages into the database file.
2. **Integrity Check**: Runs `PRAGMA integrity_check;`. If any page corruption or index inconsistency is detected, the process halts immediately before creating an invalid backup.
3. **Atomic Copy**: Writes an ISO timestamped snapshot to `server/data/backups/kiranaos_backup_<TIMESTAMP>.db`.

### Running Backup Manually
From the project root:
```bash
node scripts/backup.js
```
Sample Output:
```
--- KiranaOS Database Backup Tool ---
[*] Checkpointing SQLite WAL...
[+] Database integrity verified: OK
========================================================
 Backup Created Successfully!
 File: C:\Users\nitin\Desktop\kiranaos\server\data\backups\kiranaos_backup_2026-10-14T06-54-47-226Z.db
 Size: 136.00 KB
========================================================
```

---

## 3. Disaster Recovery & Restoration Procedure

Restoring a database snapshot replaces the active database. KiranaOS provides `scripts/restore.js` which guarantees zero accidental data loss during recovery:

1. **Pre-Restoration Integrity Verification**: The target backup file is mounted in isolation and tested with `PRAGMA integrity_check;`. If the backup file is truncated or corrupt, the restore halts immediately without touching the active store.
2. **Safety Copy of Active State**: An immediate safety copy of the existing database is created (`kiranaos.db.pre_restore_<TIMESTAMP>`).
3. **Atomic Replacement**: The backup is copied into `kiranaos.db`.
4. **Stale WAL Cleansing**: Any dangling `-wal` or `-shm` shared memory files are unlinked to avoid state collisions.

### Running Restore Manually
```bash
node scripts/restore.js server/data/backups/kiranaos_backup_2026-10-14T06-54-47-226Z.db
```
Sample Output:
```
--- KiranaOS Database Restore Tool ---
[*] Testing backup integrity...
[+] Backup file integrity verified: OK
[*] Creating safety copy of current active database: ...kiranaos.db.pre_restore_1728888000000
[*] Overwriting ...kiranaos.db with backup file...
========================================================
 Database Restored Successfully!
 Restored from: ...kiranaos_backup_2026-10-14T06-54-47-226Z.db
 Active DB:     ...server\data\kiranaos.db
========================================================
```

---

## 4. Automated Daily Backup Automation

### Windows Task Scheduler (Daily at 23:00)
To create an automated nightly backup task on Windows:
```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "C:\Users\nitin\Desktop\kiranaos\scripts\backup.js" -WorkingDirectory "C:\Users\nitin\Desktop\kiranaos"
$trigger = New-ScheduledTaskTrigger -Daily -At 11:00PM
Register-ScheduledTask -TaskName "KiranaOS_Nightly_Backup" -Action $action -Trigger $trigger -Description "Nightly SQLite backup and integrity validation for KiranaOS"
```

### Linux / macOS Cron
```cron
# Run KiranaOS backup every night at 23:00 (11 PM)
0 23 * * * cd /opt/kiranaos && /usr/bin/node scripts/backup.js >> /var/log/kiranaos-backup.log 2>&1
```

---

## 5. Cloud Offsite Sync (Optional)
While KiranaOS operates 100% offline for POS billing, backup files located in `server/data/backups/` can optionally be synced to external storage or cloud buckets (e.g. AWS S3, Google Drive, or an encrypted USB drive) using tools like `rclone` or Windows File History.
