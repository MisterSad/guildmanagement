#!/usr/bin/env python3
"""
migrate_event_ids.py — One-shot migration: fuse duplicate sessions and
rewrite every event session_id to a human-readable, chronologically-sortable
ID. Applies to ALL tenants (SaaS: never per-tenant).

ID scheme:
  - SvS           -> SVS-YYYY-Www   (ISO week of the battle date)
  - GvG           -> GVG-YYYY-Www
  - Glory         -> GLORY-YYYY-Www (weekly, derived from week_start)
  - ARMS A        -> ARA-YYYYMMDD   (battle date)
  - ARMS B        -> ARB-YYYYMMDD
  - Defend Trade  -> DTR-YYYYMMDD
  - Shadowfront S1/S2 -> SF1-/SF2-YYYYMMDD

The reference date is, in priority: event_status.start_at, else the session
creation timestamp, else week_start.

Duplicate sessions (same guild+event that resolve to the same target ID) are
fused: the session holding the most data survives, the others' participant
rows are merged in, then the duplicates are removed from event_participants,
event_status and shadowfront_squads. Glory rows get a session_id of their own.

Run (dry-run, writes nothing):  python3 scripts/migrate_event_ids.py
Run (apply):                      python3 scripts/migrate_event_ids.py --apply
"""

import sys
import json
import re
import subprocess
from collections import defaultdict
from datetime import date

APPLY = "--apply" in sys.argv


def _q(v):
    return "'" + str(v).replace("'", "''") + "'"


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
    y, m, d = map(int, datestr.split("-"))
    iso = date(y, m, d).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def date_key(datestr):
    return datestr.replace("-", "")


def target_id(event_name, start_date, sid, week_start, squad):
    up = (event_name or "").upper()
    if up == "SHADOWFRONT":
        prefix = "SF1" if squad == "squad1" else ("SF2" if squad == "squad2" else "SF")
        ref = start_date or (sid[:10] if sid else "") or (week_start or "")
        return prefix + "-" + date_key(ref)
    ref = start_date or (sid[:10] if sid else "") or (week_start or "")
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


SESSIONS = run("""
select ep.guild, ep.event_name, ep.session_id, min(ep.week_start)::text as ws,
       count(*)::int as rows, sum(case when ep.participated > 0 then 1 else 0 end)::int as present,
       sum(coalesce(ep.score,0)+coalesce(ep.score_prep,0)+coalesce(ep.score_pvp,0))::bigint as score
from public.event_participants ep
group by ep.guild, ep.event_name, ep.session_id
order by ep.guild, ep.event_name, ep.session_id;
""")

STATUS = run("""
select guild, event_name, session_id, to_char(start_at, 'YYYY-MM-DD') as start_date
from public.event_status;
""")

SQUADS = run("""
select guild, session_id, min(squad) as squad
from public.shadowfront_squads group by guild, session_id;
""")

start_by = {(s["guild"], s["session_id"]): s["start_date"] for s in STATUS if s.get("start_date")}
squad_by = {(s["guild"], s["session_id"]): s["squad"] for s in SQUADS}

sessions = []
for s in SESSIONS:
    if not s.get("session_id"):
        continue
    # Already migrated? session_id is now a readable key (SVS-2026-W32,
    # ARA-20260809, GLORY-...), not a timestamp. Skip for idempotency.
    if re.match(r"^(SVS|GVG|GLORY|ARA|ARB|DTR|SF1|SF2|EV)-", s["session_id"]):
        continue
    tid = target_id(
        s["event_name"],
        start_by.get((s["guild"], s["session_id"])),
        s["session_id"],
        s.get("ws"),
        squad_by.get((s["guild"], s["session_id"])),
    )
    if tid:
        sessions.append({**s, "target": tid})

# Fuse: group sessions of the same (guild, event) that were CREATED on the
# same calendar day (session_id[:10]). Those are duplicate re-Starts of the
# same event (startEvent always minted a fresh session id). The survivor is
# the session referenced by event_status (keeps the live event) or, failing
# that, the one holding the most data. Everything else is merged in and
# removed.
by_created = defaultdict(list)
for s in sessions:
    # Shadowfront squads are distinct events sharing a day legitimately, but
    # they still need their session_id rewritten (SF1-/SF2-...). Register them
    # as their own single-session group so the rewrite below applies.
    grp_key = (s["guild"], s["event_name"], s["session_id"][:10])
    if s["event_name"].upper() == "SHADOWFRONT":
        grp_key = (s["guild"], s["event_name"], s["session_id"])
    by_created[grp_key].append(s)

session_statuses = {(s["guild"], s["event_name"], s["session_id"]) for s in STATUS}

survivor = {}
to_delete = []  # list of (guild, event, session_id) -> survivor session_id
for key, items in by_created.items():
    if len(items) == 1:
        survivor[(items[0]["guild"], items[0]["event_name"], items[0]["session_id"])] = items[0]
        continue
    refs = [s for s in items if (s["guild"], s["event_name"], s["session_id"]) in session_statuses]
    if len(refs) == 1:
        keep = refs[0]
    else:
        keep = sorted(
            items,
            key=lambda s: (-(s["present"] or 0), -(s["rows"] or 0), s["session_id"]),
        )[0]
    survivor[(keep["guild"], keep["event_name"], keep["session_id"])] = keep
    for d in items:
        if d["session_id"] == keep["session_id"]:
            continue
        to_delete.append((d["guild"], d["event_name"], d["session_id"], keep["session_id"]))

# Fallback: exact ID collision (same target) — fuse as well.
by_target = defaultdict(list)
for s in sessions:
    by_target[(s["guild"], s["event_name"], s["target"])].append(s)
for key, items in by_target.items():
    if len(items) <= 1:
        continue
    keep = sorted(items, key=lambda s: (-(s["score"] or 0), -(s["present"] or 0), -(s["rows"] or 0), s["session_id"]))[0]
    survivor[(keep["guild"], keep["event_name"], keep["session_id"])] = keep
    for d in items:
        if d["session_id"] == keep["session_id"]:
            continue
        if not any(x[0] == d["guild"] and x[1] == d["event_name"] and x[2] == d["session_id"] for x in to_delete):
            to_delete.append((d["guild"], d["event_name"], d["session_id"], keep["session_id"]))

# Glory: every row needs a session_id. Determine which Glory weeks exist.
glory = run("""
select guild, week_start::text as ws, count(*)::int as n
from public.event_participants where event_name = 'Glory'
group by guild, week_start order by guild, week_start;
""")

print("=" * 70)
print(f"Mode: {'APPLY' if APPLY else 'DRY RUN (no writes)'}")
print(f"Sessions à réécrire: {len(sessions)}")
print(f"Sessions à fusionner (doublons): {len(to_delete)}")
print(f"Semaines Glory à renommer: {len(glory)}")
print("=" * 70)

print("\n--- FUSION DES DOUBLONS ---")
for g, ev, sid, keep_id in to_delete:
    print(f"  {g} | {ev} | {sid}  ->  (fusionnée dans {keep_id})")

print("\n--- RÉÉCRITURE SESSION_ID ---")
for key in sorted(survivor):
    s = survivor[key]
    print(f"  {s['guild']:<6} | {(s['event_name'] or '')[:22]:<22} | {(s['session_id'] or '')[:26]:<26} -> {s['target']}")

print("\n--- GLORY (session_id hebdo) ---")
for g in glory:
    print(f"  {g['guild']:<6} | week {g['ws']} | {g['n']} lignes -> GLORY-{iso_week(g['ws'])}")

if not APPLY:
    print("\n[DRY RUN] Aucune écriture. Relancer avec --apply pour exécuter.")
    sys.exit(0)

# ── Build and execute the migration ────────────────────────────────────────
sql = ["begin;"]
sql.append("set search_path to public;")

# 1. Transfer participants from fused-away sessions into the survivor.
#    Rows already present for the same pseudo are updated to the strongest
#    values (participated/score) so nothing is lost.
for g, ev, sid, keep_id in to_delete:
    sql.append(
        f"insert into public.event_participants (guild, event_name, week_start, pseudo, participated, score, score_prep, score_pvp, session_id, late, excused, appointed, sub_present, is_pending) "
        f"select guild, event_name, week_start, pseudo, participated, score, score_prep, score_pvp, {_q(keep_id)}, late, excused, appointed, sub_present, is_pending "
        f"from public.event_participants where guild={_q(g)} and event_name={_q(ev)} and session_id={_q(sid)} "
        f"on conflict (guild, event_name, session_id, pseudo) where session_id is not null do update "
        f"set participated = greatest(event_participants.participated, excluded.participated), "
        f"    score = coalesce(event_participants.score, excluded.score), "
        f"    score_prep = coalesce(event_participants.score_prep, excluded.score_prep), "
        f"    score_pvp = coalesce(event_participants.score_pvp, excluded.score_pvp);"
    )
    sql.append(f"delete from public.event_participants where guild={_q(g)} and event_name={_q(ev)} and session_id={_q(sid)};")
    sql.append(f"delete from public.shadowfront_squads where guild={_q(g)} and session_id={_q(sid)};")
    sql.append(f"delete from public.event_status where guild={_q(g)} and event_name={_q(ev)} and session_id={_q(sid)};")

# 2. Rewrite surviving session_ids in event_participants + shadowfront_squads.
for key in survivor:
    s = survivor[key]
    sql.append(f"update public.event_participants set session_id={_q(s['target'])} where guild={_q(s['guild'])} and event_name={_q(s['event_name'])} and session_id={_q(s['session_id'])};")
    sql.append(f"update public.shadowfront_squads set session_id={_q(s['target'])} where guild={_q(s['guild'])} and session_id={_q(s['session_id'])};")
    sql.append(f"update public.event_status set session_id={_q(s['target'])} where guild={_q(s['guild'])} and event_name={_q(s['event_name'])} and session_id={_q(s['session_id'])};")

# 3. Glory: assign a weekly session_id (sessioned index applies).
for g in glory:
    tid = "GLORY-" + iso_week(g["ws"])
    sql.append(f"update public.event_participants set session_id={_q(tid)} where guild={_q(g['guild'])} and event_name='Glory' and week_start='{g['ws']}'::date and session_id is null;")

sql.append("commit;")
sql.append("notify pgrst, 'reload schema';")

stmt = "\n".join(sql)
out = subprocess.run(
    ["supabase", "db", "query", "--linked"],
    input=stmt,
    capture_output=True,
    text=True,
)
print("\n--- RÉSULTAT EXÉCUTION ---")
print(out.stdout[-4000:])
if out.returncode != 0:
    print(out.stderr[-2000:])
