#!/usr/bin/env python3
"""
analyze_event_ids.py — DRY RUN planner for the event session_id migration.

Reads every distinct (guild, event_name, session_id) from event_participants,
computes the target human-readable ID for each session, and reports:
  - the target ID per session
  - duplicate groups (same guild+event+target) that need merging before any
    session_id rewrite, so the unique indexes never collide.

No writes. Run:  python3 scripts/analyze_event_ids.py
"""

import subprocess
import json
import re

QUERY = """
select ep.guild, ep.event_name, ep.session_id, min(ep.week_start)::text as ws,
       count(*)::int as rows, sum(case when ep.participated > 0 then 1 else 0 end)::int as present
from public.event_participants ep
group by ep.guild, ep.event_name, ep.session_id
order by ep.guild, ep.event_name, ep.session_id;
"""

STATUS_QUERY = """
select guild, event_name, session_id, to_char(start_at, 'YYYY-MM-DD') as start_date
from public.event_status order by guild, event_name;
"""

SQUAD_QUERY = """
select guild, session_id, min(squad) as squad
from public.shadowfront_squads
group by guild, session_id order by guild, session_id;
"""


def run(sql):
    p = subprocess.run(
        ["supabase", "db", "query", "--linked"],
        input=sql,
        capture_output=True,
        text=True,
    )
    m = re.search(r"\[.*\]", p.stdout, re.S)
    return json.loads(m.group(0)) if m else []


def iso_week(datestr):
    from datetime import date
    y, m, d = map(int, datestr.split("-"))
    iso = date(y, m, d).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def date_key(datestr):
    return datestr.replace("-", "")


def target_id(event_name, start_date, sid, week_start):
    """Human-readable ID per event type, triable chronologically."""
    up = (event_name or "").upper()
    # Reference date: chosen battle date > session creation date > week start.
    ref = start_date or (sid[:10] if sid else None) or (week_start or "")
    if not ref:
        ref = week_start or ""
    if up == "SVS":
        return "SVS-" + iso_week(ref)
    if up == "GVG":
        return "GVG-" + iso_week(ref)
    if up == "GLORY":
        return "GLORY-" + iso_week(week_start or ref)
    if up == "ARMS RACE STAGE A":
        return "ARA-" + date_key(ref)
    if up == "ARMS RACE STAGE B":
        return "ARB-" + date_key(ref)
    if up == "DEFEND TRADE ROUTE":
        return "DTR-" + date_key(ref)
    return None


def main():
    sessions = run(QUERY)
    statuses = run(STATUS_QUERY)
    squads = run(SQUAD_QUERY)

    start_by = {}
    for s in statuses:
        key = (s["guild"], s["session_id"])
        if s.get("start_date"):
            start_by.setdefault(key, s["start_date"])

    squad_by = {}
    for s in squads:
        squad_by[(s["guild"], s["session_id"])] = s.get("squad")

    plan = []
    for s in sessions:
        if not s.get("session_id"):
            continue
        start = start_by.get((s["guild"], s["session_id"]))
        tid = target_id(s["event_name"], start, s["session_id"], s.get("ws"))
        squad = squad_by.get((s["guild"], s["session_id"]))
        if s["event_name"].upper() == "SHADOWFRONT":
            # Shadowfront uses event_status names (Squad 1/2) or shadowfront_squads.
            label = squad or "SF"
            prefix = "SF1" if label == "squad1" else ("SF2" if label == "squad2" else "SF")
            tid = prefix + "-" + date_key(start or s["session_id"][:10])
        plan.append({**s, "target": tid, "start_date": start, "squad": squad})

    # Group by (guild, event_name, target)
    from collections import defaultdict
    groups = defaultdict(list)
    for p in plan:
        groups[(p["guild"], p["event_name"], p["target"])].append(p)

    print(f"Sessions analysées: {len(plan)}\n")
    print("\n=== Doublons de MÊME SEMAINE (même guild+event, plusieurs sessions) ===")
    print("   (candidats à la fusion: une session porte les données, l'autre est une coquille)")
    from collections import defaultdict
    week_groups = defaultdict(list)
    for p in plan:
        if p["event_name"].upper() == "SHADOWFRONT":
            continue
        week_groups[(p["guild"], p["event_name"], p.get("ws"))].append(p)
    for key, items in sorted(week_groups.items()):
        if len(items) > 1:
            print(f"\n  {key[0]} | {key[1]} | semaine {key[2]} ({len(items)} sessions)")
            for it in items:
                print(f"     - {it['session_id']}  rows={it['rows']} present={it['present']} start={it['start_date']}")

    print("\n=== DOUBLONS (même guild+event+ID cible) à fusionner avant réécriture ===")
    dup_total = 0
    for key, items in sorted(groups.items()):
        if len(items) > 1:
            dup_total += len(items)
            print(f"\n  {key[0]} | {key[1]} -> {key[2]}  ({len(items)} sessions)")
            for it in items:
                print(f"     - {it['session_id']}  rows={it['rows']} present={it['present']} start={it['start_date']}")
    print(f"\nTotal sessions impliquées dans des doublons: {dup_total}")

    print("\n=== Échantillon de mapping (une ligne par session unique) ===")
    seen = set()
    for p in plan:
        k = (p["guild"], p["event_name"], p["session_id"])
        if k in seen:
            continue
        seen.add(k)
        if len([x for x in groups[(p["guild"], p["event_name"], p["target"])]]) == 1:
            print(f"  {p['guild']:<6} | {(p['event_name'] or '')[:22]:<22} | {(p['session_id'] or '')[:26]:<26} -> {p['target']}")


if __name__ == "__main__":
    main()
