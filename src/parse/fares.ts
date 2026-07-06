/**
 * Parses the RSPS5045 fares feed: locations (.LOC), flows and fares (.FFL),
 * and ticket types (.TTY). Field positions were confirmed against the real
 * feed files, column by column - the wiki spec page is unreachable (403s
 * non-browser clients).
 *
 * Each file uses multiple record types distinguished by column 2 (LOC,
 * FFL) or is a single flat record shape (TTY). Only the record types we
 * need are parsed; everything else is skipped by the streaming functions.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface LocationRecord {
  readonly nlc: string;
  readonly crs: string | null;
  readonly name: string;
  /**
   * The NLC of this location's fare group, e.g. London termini all share
   * the "LONDON TERMINALS" group NLC 1072. Flows are often priced against
   * the group rather than the individual station. Equal to `nlc` itself
   * when the location isn't part of a group.
   */
  readonly fareGroupNlc: string;
}

export interface FlowRecord {
  readonly flowId: string;
  readonly originNlc: string;
  readonly destinationNlc: string;
  readonly routeCode: string;
}

export interface FareRecord {
  readonly flowId: string;
  readonly ticketCode: string;
  readonly pricePence: number;
  readonly restrictionCode: string | null;
}

export interface TicketTypeRecord {
  readonly code: string;
  readonly description: string;
  readonly klass: string | null;
  readonly type: string | null;
}

/** Parses an "L" (Location) record from the .LOC file. Null for other record types. */
export function parseLocationLine(line: string): LocationRecord | null {
  if (line[1] !== 'L') return null;
  const crs = line.slice(56, 59).trim();
  return {
    nlc: line.slice(36, 40),
    crs: crs || null,
    name: line.slice(40, 56).trim(),
    fareGroupNlc: line.slice(69, 75).trim(),
  };
}

/** Parses an "F" (Flow) record from the .FFL file. Null for other record types. */
export function parseFlowLine(line: string): FlowRecord | null {
  if (line[1] !== 'F') return null;
  return {
    originNlc: line.slice(2, 6),
    destinationNlc: line.slice(6, 10),
    routeCode: line.slice(10, 15),
    flowId: line.slice(42, 49),
  };
}

/** Parses a "T" (Fare) record from the .FFL file. Null for other record types. */
export function parseFareLine(line: string): FareRecord | null {
  if (line[1] !== 'T') return null;
  const restriction = line.slice(20, 22).trim();
  return {
    flowId: line.slice(2, 9),
    ticketCode: line.slice(9, 12),
    pricePence: Number(line.slice(12, 20)),
    restrictionCode: restriction || null,
  };
}

/**
 * Parses a ticket type data row from the .TTY file. Null for header/footer
 * comment lines (which start with "/" rather than an update marker).
 */
export function parseTicketTypeLine(line: string): TicketTypeRecord | null {
  if (line.length < 46 || line[0] === '/') return null;
  return {
    code: line.slice(1, 4),
    description: line.slice(28, 43).trim(),
    klass: line.slice(43, 44).trim() || null,
    type: line.slice(44, 45).trim() || null,
  };
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

export async function* streamLocations(filePath: string): AsyncGenerator<LocationRecord> {
  for await (const line of readLines(filePath)) {
    const location = parseLocationLine(line);
    if (location) yield location;
  }
}

export async function* streamTicketTypes(filePath: string): AsyncGenerator<TicketTypeRecord> {
  for await (const line of readLines(filePath)) {
    const ticketType = parseTicketTypeLine(line);
    if (ticketType) yield ticketType;
  }
}

export type FlowOrFare =
  | { readonly kind: 'flow'; readonly flow: FlowRecord }
  | { readonly kind: 'fare'; readonly fare: FareRecord };

/**
 * Streams the .FFL file, keeping only flows where both the origin and
 * destination NLC are served by Southeastern (per `isSeNlc`), plus the fare
 * records that belong to those kept flows.
 *
 * Fare ("T") records always follow their flow ("F") record in the feed, so
 * a single accepted-flow-id set tracked while streaming is enough - no
 * second pass or full in-memory flow list is needed.
 */
export async function* streamSeFlowsAndFares(
  filePath: string,
  isSeNlc: (nlc: string) => boolean,
): AsyncGenerator<FlowOrFare> {
  const acceptedFlowIds = new Set<string>();

  for await (const line of readLines(filePath)) {
    const recordType = line[1];
    if (recordType === 'F') {
      const flow = parseFlowLine(line);
      if (flow && isSeNlc(flow.originNlc) && isSeNlc(flow.destinationNlc)) {
        acceptedFlowIds.add(flow.flowId);
        yield { kind: 'flow', flow };
      }
    } else if (recordType === 'T') {
      const fare = parseFareLine(line);
      if (fare && acceptedFlowIds.has(fare.flowId)) {
        yield { kind: 'fare', fare };
      }
    }
  }
}
