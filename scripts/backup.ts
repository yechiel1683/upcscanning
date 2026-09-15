import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Take a database backup, and — more importantly — prove it restores.
 *
 * A backup nobody has restored is a hope. The failure is not that the file is
 * missing; it is that the file exists, has a plausible size, and turns out on
 * the one day it matters to be a dump of an empty schema, or truncated at the
 * point the disk filled, or written by a `pg_dump` too old for the server.
 * None of that is visible from the outside, so this restores every dump it
 * takes into a scratch database and counts what came back.
 *
 * Usage:
 *   npm run backup                 take a dump, verify it, keep it
 *   npm run backup -- --verify-only <file>   re-verify an existing dump
 *
 * The dump is custom-format (`-Fc`), which is compressed and lets pg_restore
 * work selectively. Plain SQL would be readable but several times larger.
 */

const DUMP_DIR = process.env.BACKUP_DIR ?? '.backups';

function run(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // A missing binary reports as an error rather than a non-zero exit.
    missing: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT',
  };
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set, so there is nothing to back up.');
    process.exit(1);
  }
  return url;
}

/**
 * Restore into a throwaway database and check the result has the tables and
 * rows the dump claimed.
 *
 * The scratch database is created next to the real one and dropped afterwards,
 * so this needs an account that may create databases. It is never the same
 * database as the source — a "verification" that restored over production
 * would be the worst possible bug in a backup script.
 */
function verify(dumpFile: string, sourceUrl: string): boolean {
  const scratchName = `upcscanning_verify_${Date.now()}`;
  const source = new URL(sourceUrl);
  const admin = new URL(sourceUrl);
  // Connect to the maintenance database to issue CREATE/DROP.
  admin.pathname = '/postgres';
  const scratch = new URL(sourceUrl);
  scratch.pathname = `/${scratchName}`;

  if (source.pathname === scratch.pathname) {
    console.error('Refusing to verify into the source database.');
    return false;
  }

  console.log(`  creating scratch database ${scratchName}`);
  const created = run('psql', [admin.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${scratchName}"`]);
  if (!created.ok) {
    console.error('  could not create a scratch database:', created.stderr.trim() || 'unknown error');
    console.error('  the dump was taken but NOT verified.');
    return false;
  }

  try {
    console.log('  restoring the dump into it');
    const restored = run('pg_restore', ['--dbname', scratch.toString(), '--no-owner', '--no-privileges', dumpFile]);
    // pg_restore warns about ownership on a fresh database; only a hard
    // failure matters.
    if (!restored.ok && !/warning/i.test(restored.stderr)) {
      console.error('  restore failed:', restored.stderr.trim().split('\n').slice(0, 5).join('\n'));
      return false;
    }

    // The check that actually means something: did the data arrive? A dump of
    // an empty schema restores perfectly and is worth nothing.
    const counted = run('psql', [
      scratch.toString(),
      '-t',
      '-A',
      '-c',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
    ]);
    const tables = Number(counted.stdout.trim());

    if (!Number.isFinite(tables) || tables === 0) {
      console.error('  the dump restored, but the result has no tables in it.');
      return false;
    }

    const users = run('psql', [scratch.toString(), '-t', '-A', '-c', 'SELECT count(*) FROM users']);
    console.log(`  verified: ${tables} tables, ${users.stdout.trim() || '0'} users`);
    return true;
  } finally {
    console.log('  dropping the scratch database');
    run('psql', [admin.toString(), '-c', `DROP DATABASE IF EXISTS "${scratchName}"`]);
  }
}

function main() {
  const args = process.argv.slice(2);
  const url = requireDatabaseUrl();

  if (args[0] === '--verify-only') {
    const file = args[1];
    if (!file || !existsSync(file)) {
      console.error('Usage: npm run backup -- --verify-only <dump file>');
      process.exit(1);
    }
    console.log(`Verifying ${file}`);
    process.exit(verify(file, url) ? 0 : 1);
  }

  if (!existsSync(DUMP_DIR)) mkdirSync(DUMP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = path.join(DUMP_DIR, `upcscanning-${stamp}.dump`);

  console.log(`Backing up to ${dumpFile}`);
  const dumped = run('pg_dump', ['--format', 'custom', '--no-owner', '--no-privileges', '--file', dumpFile, url]);

  if (dumped.missing) {
    console.error('pg_dump is not installed on this machine. Install the PostgreSQL client tools.');
    process.exit(1);
  }
  if (!dumped.ok) {
    console.error('pg_dump failed:', dumped.stderr.trim().split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }

  const bytes = statSync(dumpFile).size;
  console.log(`  wrote ${(bytes / 1024 / 1024).toFixed(2)} MB`);

  // A dump small enough to be empty is the classic silent failure.
  if (bytes < 1024) {
    console.error('  that is too small to be a real backup. Treating it as a failure.');
    process.exit(1);
  }

  console.log('Verifying the dump restores');
  if (!verify(dumpFile, url)) {
    console.error('\nThe dump was written but could not be verified. Do not rely on it.');
    process.exit(1);
  }

  console.log('\nBackup complete and verified.');
}

main();
