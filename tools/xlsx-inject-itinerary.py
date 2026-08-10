#!/usr/bin/env python3
"""
Inject the spreadsheet's Outward itinerary (columns E/F) into the ticket JSON so
the batch runner can use it, until the ticketing export carries an `Itinerary`
block itself.

The test spreadsheets have, per ticket: UTN, ..., "Outward Ticket Itinerary"
(e.g. "08:01 Swanley to 08:35 London Terminals"), "Outward Ticket Service UID",
and "Scan Data" (the raw ticket JSON). This reads each row, derives the itinerary
legs, and writes batch-ready JSON with `Ticket.Itinerary` populated - which
src/predict/itinerary.ts already parses.

Endpoint CRS come from the ticket's Origin/Destination NLC (authoritative). A
London-terminals group NLC (1072) with no CRS of its own is resolved to the
specific terminal the scans used - a gate scan at a member station, else the
train_info route origin. The leg times come from column E.

Limitations (printed per ticket): only the Outward/Single itinerary is in the
sheet, so return coupons get none; and a two-service UID (a cross-London change)
is emitted as a single origin->destination leg with the overall times, since the
sheet does not give the interchange - fine for the intended-arrival baseline but
not for full multi-leg modelling.

Usage: python3 tools/xlsx-inject-itinerary.py <xlsx> [spike.db] [out_dir]
"""

import sqlite3, json, zipfile, re, sys, os
import xml.etree.ElementTree as ET

NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_rows(xlsx_path):
    z = zipfile.ZipFile(xlsx_path)
    shared = []
    with z.open("xl/sharedStrings.xml") as f:
        for si in ET.parse(f).getroot().findall("a:si", NS):
            shared.append("".join(t.text or "" for t in si.iter() if t.tag.endswith("}t")))
    sheet = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", n))[0]
    with z.open(sheet) as f:
        root = ET.parse(f).getroot()
    rows = {}
    for c in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
        v = c.find("a:v", NS)
        val = ""
        if v is not None:
            val = v.text
            if c.get("t") == "s":
                val = shared[int(val)]
        m = re.match(r"([A-Z]+)(\d+)", c.get("r"))
        rows.setdefault(int(m.group(2)), {})[m.group(1)] = val
    return rows


def parse_itin_text(text):
    m = re.match(r"\s*(\d{1,2}:\d{2})\s+.*?\s+to\s+(\d{1,2}:\d{2})\s+.*?\s*$", text or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def scans_of(ticket):
    return [s["Scan"] for s in (ticket.get("Scans") or []) if s.get("Scan")]


def train_info_origin(scans):
    for s in scans:
        m = re.search(r"\b([A-Z]{3})-([A-Z]{3})\b", s.get("train_info") or "")
        if m:
            return m.group(1)
    return None


def resolve_crs(conn, nlc, scans):
    row = conn.execute("SELECT crs, fare_group_nlc FROM locations WHERE nlc = ?", (nlc,)).fetchone()
    if not row:
        return None, "unknown NLC"
    crs, group = row
    if crs:
        return crs, None
    members = {r[0] for r in conn.execute(
        "SELECT crs FROM locations WHERE fare_group_nlc = ? AND crs IS NOT NULL", (group,))}
    for s in scans:  # a gate scan at a group member
        st = s.get("STATION")
        if st:
            r = conn.execute("SELECT crs FROM locations WHERE nlc = ?", (st,)).fetchone()
            if r and r[0] in members:
                return r[0], f"terminal from scan"
    ti = train_info_origin(scans)  # else the train_info route origin
    if ti and ti in members:
        return ti, "terminal from train_info"
    return None, "London terminal not resolvable"


def coupon_of(scans):
    cts = {s.get("coupon_type") for s in scans if s.get("coupon_type")}
    return "Single" if "Single" in cts or not cts else "Outward"


def main():
    xlsx = sys.argv[1]
    db = sys.argv[2] if len(sys.argv) > 2 else "data/spike.db"
    out_dir = sys.argv[3] if len(sys.argv) > 3 else "data/dr-spike-aug10-itin"
    os.makedirs(out_dir, exist_ok=True)
    conn = sqlite3.connect(db)
    rows = read_rows(xlsx)

    tickets = []
    for r in sorted(rows):
        if r == 1:
            continue
        cells = rows[r]
        raw = cells.get("G")
        if not raw:
            continue
        doc = json.loads(raw)
        dep, arr = parse_itin_text(cells.get("E"))
        uid = (cells.get("F") or "").split("|")[-1].strip() or None
        for resp in doc.get("Response", []):
            for tk in resp.get("Tickets", []):
                t = tk["Ticket"]
                scans = scans_of(t)
                coupon = coupon_of(scans)
                cscans = [s for s in scans if (s.get("coupon_type") in (coupon, None))]
                o_crs, o_note = resolve_crs(conn, t.get("OriginNLC"), cscans)
                d_crs, d_note = resolve_crs(conn, t.get("DestinationNLC"), cscans)
                if dep and arr and o_crs and d_crs:
                    t["Itinerary"] = [{
                        "coupon_type": coupon,
                        "legs": [{
                            "origin_crs": o_crs, "destination_crs": d_crs,
                            "scheduled_departure": dep, "scheduled_arrival": arr,
                            "service_id": uid,
                        }],
                    }]
                    notes = "; ".join(n for n in (o_note, d_note) if n)
                    print(f"{t['UTN']}: itinerary {o_crs} {dep} -> {d_crs} {arr}"
                          f"{' (' + notes + ')' if notes else ''}")
                else:
                    print(f"{t['UTN']}: NO itinerary injected "
                          f"(dep={dep} arr={arr} origin={o_crs or o_note} dest={d_crs or d_note})")
                tickets.append(tk)

    out = {"return_code": "ok", "message": None,
           "Response": [{"Error": {"Code": "00", "Message": None}, "Tickets": tickets}]}
    path = os.path.join(out_dir, "tickets.json")
    with open(path, "w") as f:
        f.write(json.dumps(out, indent=2) + "\n")
    print(f"\nwrote {len(tickets)} tickets to {path}")


if __name__ == "__main__":
    main()
