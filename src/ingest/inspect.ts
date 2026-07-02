/**
 * Prints a summary of the data downloaded by download.ts so we can see what
 * each NRDP feed actually contains: the files in each feed directory with
 * their sizes, and the first few lines of every text file to reveal the
 * record formats. This is a look-only script - it does no parsing.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const DATA_DIR = 'data';
const FEED_DIRS = ['fares', 'routeing', 'timetable'];
const PREVIEW_LINES = 5;
/** How many bytes to sniff when deciding whether a file is text or binary. */
const SNIFF_BYTES = 8192;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Recursively lists every file under a directory, as absolute paths. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/**
 * Reads the first chunk of a file and guesses whether it is text.
 * A NUL byte in the first few KB is a reliable signal that it is binary.
 */
async function isTextFile(file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start: 0, end: SNIFF_BYTES - 1 });
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      stream.destroy();
      resolve(!buf.includes(0));
    });
    stream.on('end', () => resolve(true)); // empty file: treat as text
    stream.on('error', reject);
  });
}

/** Prints up to PREVIEW_LINES lines from the start of a text file. */
async function previewLines(file: string): Promise<void> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
  let count = 0;
  for await (const line of rl) {
    console.log(`      | ${line}`);
    count += 1;
    if (count >= PREVIEW_LINES) break;
  }
  rl.close();
  if (count === 0) console.log('      | (empty)');
}

async function inspectFeed(feed: string): Promise<void> {
  const dir = path.join(DATA_DIR, feed);
  console.log(`\n=== ${feed} (${dir}) ===`);

  let files: string[];
  try {
    files = await listFiles(dir);
  } catch {
    console.log('  (directory not found - run `npm run download` first)');
    return;
  }

  if (files.length === 0) {
    console.log('  (no files)');
    return;
  }

  for (const file of files.sort()) {
    const { size } = await stat(file);
    const relative = path.relative(dir, file);
    console.log(`\n  ${relative}  (${formatBytes(size)})`);

    if (await isTextFile(file)) {
      console.log(`    first ${PREVIEW_LINES} lines:`);
      await previewLines(file);
    } else {
      console.log('    (binary file - preview skipped)');
    }
  }
}

async function main(): Promise<void> {
  console.log('Inspecting downloaded NRDP feeds...');
  for (const feed of FEED_DIRS) {
    await inspectFeed(feed);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
