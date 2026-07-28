import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards against the failure mode that broke a deploy: a source file excluded
 * by .gitignore.
 *
 * It is silent and total. `git status` stays clean, `git add -A` skips the file
 * without a word, every local build and test passes because the file is right
 * there on disk — and the deploy fails at "Module not found" because the build
 * server only ever sees what git tracked. The cause was an unanchored
 * "storage/" pattern, which matches a directory of that name at any depth and
 * so swallowed src/server/storage/ along with the intended ./storage output
 * directory.
 *
 * Anything the build can import must therefore be in the repository.
 */

const SOURCE_ROOTS = ['src', 'prisma', 'tests'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.prisma', '.sql', '.mjs', '.js']);

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, found);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Ask git which of these paths the ignore rules match.
 *
 * `--no-index` is essential. Without it, check-ignore stays silent about files
 * that happen to be tracked already, so a dangerous rule goes unreported the
 * moment someone force-adds the file it swallowed — the guard would pass while
 * the landmine stayed armed for the next file to land in that directory.
 * With it, the rules are judged on their own merits.
 */
function ignoredAmong(files: string[]): string[] {
  if (files.length === 0) return [];
  try {
    // check-ignore exits 1 when nothing matches, which execFileSync treats as
    // a failure, so the empty case is handled in the catch below.
    const output = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
      input: files.join('\n'),
      encoding: 'utf8',
    });
    return output.split('\n').filter(Boolean);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return []; // Nothing ignored.
    throw error;
  }
}

describe('repository integrity', () => {
  const sourceFiles = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(root));

  it('finds the source tree', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(sourceFiles.length).toBeGreaterThan(30);
  });

  it('does not gitignore any source file', () => {
    const ignored = ignoredAmong(sourceFiles);

    expect(
      ignored,
      ignored.length > 0
        ? `These source files are excluded by .gitignore and will be missing on any ` +
            `build server, even though they build fine locally:\n  ${ignored.join('\n  ')}`
        : '',
    ).toEqual([]);
  });

  it('keeps the storage driver in the repository', () => {
    // The specific file whose absence broke the deploy. Named explicitly so a
    // regression points straight at the history rather than a generic list.
    expect(ignoredAmong(['src/server/storage/index.ts'])).toEqual([]);

    const tracked = execFileSync('git', ['ls-files', 'src/server/storage/index.ts'], {
      encoding: 'utf8',
    }).trim();
    expect(tracked, 'the storage driver must be committed, not merely un-ignored').toBe(
      'src/server/storage/index.ts',
    );
  });

  it('still ignores the local storage output directory', () => {
    // The original intent of the rule must survive the fix.
    expect(ignoredAmong(['storage/batches/abc/images/x.jpg'])).toHaveLength(1);
    expect(ignoredAmong(['.env'])).toHaveLength(1);
    expect(ignoredAmong(['node_modules/foo/index.js'])).toHaveLength(1);
  });
});
