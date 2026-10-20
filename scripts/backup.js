// npm run backup  — writes a consistent copy of the database to data/backups (safe while the server runs).
import { backupNow, listBackups } from '../server/backup.js';
const name = backupNow();
console.log('Backup written:', name);
console.log(listBackups().map(b => `  ${b.name}  ${(b.size / 1024).toFixed(0)} KB`).join('\n'));
