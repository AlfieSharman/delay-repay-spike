/**
 * Downloads the National Rail Data Portal (NRDP) static feeds.
 *
 * Flow:
 *   1. Authenticate against the NRDP with the credentials in .env to get a
 *      short-lived token. The token is fetched fresh on every run and never
 *      cached or written to disk.
 *   2. Download each static feed as a ZIP, streaming straight to disk so the
 *      large timetable feed never has to sit in memory.
 *   3. Unzip each archive into its own directory under data/.
 *
 * Conditional requests: the Last-Modified header returned for each feed is
 * stored in data/last-modified.json. On the next run we send If-Modified-Since
 * and skip any feed the server reports as unchanged (HTTP 304).
 */

import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extract from 'extract-zip';

const AUTH_URL = 'https://opendata.nationalrail.co.uk/authenticate';

interface Feed {
  /** Short name used for filenames and the extraction directory. */
  readonly name: string;
  readonly url: string;
}

const FEEDS: readonly Feed[] = [
  { name: 'fares', url: 'https://opendata.nationalrail.co.uk/api/staticfeeds/2.0/fares' },
  { name: 'routeing', url: 'https://opendata.nationalrail.co.uk/api/staticfeeds/2.0/routeing' },
  { name: 'timetable', url: 'https://opendata.nationalrail.co.uk/api/staticfeeds/3.0/timetable' },
];

const DATA_DIR = 'data';
const ZIPS_DIR = path.join(DATA_DIR, 'zips');
const LAST_MODIFIED_FILE = path.join(DATA_DIR, 'last-modified.json');

/** Map of feed name -> the Last-Modified value the server last sent us. */
type LastModifiedMap = Record<string, string>;

/** YYYY-MM-DD in UTC, used to date-stamp downloaded ZIP filenames. */
function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Human-readable byte count, e.g. 1536 -> "1.5 KB". */
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

/**
 * Step 1: exchange the .env credentials for a fresh auth token.
 * Exits the process non-zero on any failure, since nothing else can proceed.
 */
async function authenticate(): Promise<string> {
  const username = process.env.NRDP_USERNAME;
  const password = process.env.NRDP_PASSWORD;

  if (!username || !password) {
    console.error(
      'Missing NRDP_USERNAME or NRDP_PASSWORD.\n' +
        'Copy .env.example to .env and fill in your National Rail Data Portal credentials.',
    );
    process.exit(1);
  }

  console.log('Authenticating with NRDP...');

  const body = new URLSearchParams({ username, password });
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    console.error(
      `Authentication failed (HTTP ${res.status} ${res.statusText}).\n` +
        'Your credentials in .env are likely wrong.',
    );
    process.exit(1);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    console.error(
      'Authentication response did not contain a token.\n' +
        'Your credentials in .env are likely wrong.',
    );
    process.exit(1);
  }

  console.log('Authenticated.');
  return data.token;
}

async function loadLastModified(): Promise<LastModifiedMap> {
  try {
    return JSON.parse(await readFile(LAST_MODIFIED_FILE, 'utf8')) as LastModifiedMap;
  } catch {
    // First run, or the file was cleared: start with an empty map.
    return {};
  }
}

async function saveLastModified(map: LastModifiedMap): Promise<void> {
  await writeFile(LAST_MODIFIED_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

/**
 * Downloads a single feed's ZIP to data/zips/, streaming it to disk.
 * Returns the path to the saved ZIP, or null if the server reported the feed
 * as unchanged (304) and there was nothing to download.
 */
async function downloadFeed(
  feed: Feed,
  token: string,
  lastModified: LastModifiedMap,
): Promise<string | null> {
  const headers: Record<string, string> = { 'X-Auth-Token': token };
  const previous = lastModified[feed.name];
  if (previous) headers['If-Modified-Since'] = previous;

  console.log(`Downloading ${feed.name}...`);
  const res = await fetch(feed.url, { headers });

  if (res.status === 304) {
    console.log(`  ${feed.name}: feed unchanged since ${previous}`);
    return null;
  }

  if (!res.ok || !res.body) {
    console.error(`Failed to download ${feed.name} (HTTP ${res.status} ${res.statusText}).`);
    process.exit(1);
  }

  const zipPath = path.join(ZIPS_DIR, `${feed.name}-${todayStamp()}.zip`);
  // Stream the response body straight to disk; the timetable feed is far too
  // large to buffer in memory.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));

  const { size } = await stat(zipPath);
  console.log(`  ${feed.name}: saved ${formatBytes(size)} to ${zipPath}`);

  const modified = res.headers.get('last-modified');
  if (modified) lastModified[feed.name] = modified;

  return zipPath;
}

/** Unzips an archive into a fresh data/<feed>/ directory. */
async function unzipFeed(feed: Feed, zipPath: string): Promise<void> {
  const target = path.resolve(DATA_DIR, feed.name);
  // Clear any previous extraction so stale files never linger between runs.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  console.log(`Unzipping ${feed.name}...`);
  // extract-zip expects an absolute destination path.
  await extract(path.resolve(zipPath), { dir: target });
  console.log(`  ${feed.name}: extracted to ${path.join(DATA_DIR, feed.name)}`);
}

async function main(): Promise<void> {
  await mkdir(ZIPS_DIR, { recursive: true });

  const token = await authenticate();
  const lastModified = await loadLastModified();

  for (const feed of FEEDS) {
    const zipPath = await downloadFeed(feed, token, lastModified);
    if (zipPath) await unzipFeed(feed, zipPath);
  }

  await saveLastModified(lastModified);
  console.log('Done. Run `npm run inspect` to see what was downloaded.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
