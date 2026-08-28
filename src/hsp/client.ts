/**
 * Client for the Historic Service Performance (HSP) API.
 *
 * HSP is a shared industry service behind HTTP Basic Auth, using the same
 * NRDP credentials as the static feeds. Two endpoints matter here:
 *
 *   serviceMetrics  - given a flow (from/to CRS) and a time/date window,
 *                     returns the services that ran, each with a list of RIDs
 *                     (one per matching day) plus lateness tolerance metrics.
 *   serviceDetails  - given one RID, returns scheduled vs actual times at
 *                     every calling point of that specific service run.
 *
 * serviceMetrics is how you find RIDs; serviceDetails is how you get the
 * actual times to compare against the timetable.
 *
 * Responsible use of a shared service:
 *  - requests are serialised (never fired in parallel) with a 200ms gap;
 *  - responses are cached to data/hsp-cache/ keyed on a hash of the request,
 *    so repeated spike runs don't re-query. Pass { cache: false } to bypass.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://hsp-prod.rockshore.net/api/v1';
const REQUEST_GAP_MS = 200;

export type Days = 'WEEKDAY' | 'SATURDAY' | 'SUNDAY';

export interface ServiceMetricsRequest {
  readonly from_loc: string;
  readonly to_loc: string;
  /** HHMM. */
  readonly from_time: string;
  readonly to_time: string;
  /** YYYY-MM-DD. */
  readonly from_date: string;
  readonly to_date: string;
  readonly days: Days;
}

export interface ServiceMetric {
  readonly tolerance_value: string;
  readonly num_not_tolerance: string;
  readonly num_tolerance: string;
  readonly percent_tolerance: string;
  readonly global_tolerance: boolean;
}

export interface ServiceMetricsEntry {
  readonly serviceAttributesMetrics: {
    readonly origin_location: string;
    readonly destination_location: string;
    /** Public timetable departure at from_loc, HHMM. */
    readonly gbtt_ptd: string;
    /** Public timetable arrival at to_loc, HHMM. */
    readonly gbtt_pta: string;
    readonly toc_code: string;
    readonly matched_services: string;
    /** One RID per matching day in the requested window. */
    readonly rids: readonly string[];
  };
  readonly Metrics: readonly ServiceMetric[];
}

export interface ServiceMetricsResponse {
  readonly header: { readonly from_location: string; readonly to_location: string };
  readonly Services: readonly ServiceMetricsEntry[];
}

export interface ServiceDetailsLocation {
  /** CRS code of the calling point. */
  readonly location: string;
  /** Public timetable departure/arrival, HHMM ("" when not applicable). */
  readonly gbtt_ptd: string;
  readonly gbtt_pta: string;
  /** Actual departure/arrival, HHMM ("" when cancelled or not applicable). */
  readonly actual_td: string;
  readonly actual_ta: string;
  readonly late_canc_reason: string;
}

export interface ServiceDetailsResponse {
  readonly serviceAttributesDetails: {
    readonly date_of_service: string;
    readonly toc_code: string;
    readonly rid: string;
    readonly locations: readonly ServiceDetailsLocation[];
  };
}

export interface HspClientOptions {
  readonly username: string;
  readonly password: string;
  /** Cache responses to disk and serve from cache. Default true. */
  readonly cache?: boolean;
  readonly cacheDir?: string;
}

export class HspClient {
  private readonly authHeader: string;
  private readonly cache: boolean;
  private readonly cacheDir: string;
  /** Serialises requests and enforces the inter-request gap. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HspClientOptions) {
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
    this.cache = options.cache ?? true;
    this.cacheDir = options.cacheDir ?? path.join('data', 'hsp-cache');
  }

  serviceMetrics(request: ServiceMetricsRequest): Promise<ServiceMetricsResponse> {
    return this.post<ServiceMetricsResponse>('serviceMetrics', request);
  }

  serviceDetails(rid: string): Promise<ServiceDetailsResponse> {
    return this.post<ServiceDetailsResponse>('serviceDetails', { rid });
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    const cacheFile = path.join(this.cacheDir, `${endpoint}-${hash(`${endpoint}:${payload}`)}.json`);

    if (this.cache) {
      const cached = await readCache<T>(cacheFile);
      if (cached !== null) return cached;
    }

    const response = await this.enqueue(() => this.fetchJson<T>(endpoint, payload));

    if (this.cache) await writeCache(cacheFile, response);
    return response;
  }

  private async fetchJson<T>(endpoint: string, payload: string): Promise<T> {
    const res = await fetch(`${BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: payload,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HSP ${endpoint} failed (HTTP ${res.status} ${res.statusText}). ${text}`.trim());
    }
    return (await res.json()) as T;
  }

  /** Chains onto the queue so requests run one at a time, REQUEST_GAP_MS apart. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await delay(REQUEST_GAP_MS);
      return task();
    });
    // Keep the queue alive regardless of whether this task rejected.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCache<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeCache(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}
