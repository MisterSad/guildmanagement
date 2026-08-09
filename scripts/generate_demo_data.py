#!/usr/bin/env python3
"""
generate_demo_data.py — Seed the fictional DEMO tenant for public screenshots.

Creates:
  - guilds row  (id = DEMO, server_number = #0000, subscription = Unlimited)
  - guild_config (join code + coeffs, mirroring ALPHA defaults)
  - 200 fictional guild_members (pseudo, uid, power, role R1..R5, tz)
  - 4 weeks of Glory + events (DTR, ARMS A/B, SvS, GvG, Shadowfront) with
    fictional scores and participation in event_participants / event_status.

Everything is 100% fictitious. Run:  python3 scripts/generate_demo_data.py | supabase db query --linked
"""

import hashlib
import random
import sys
import uuid

random.seed(20260808)

GUILD = "DEMO"
SERVER = "#0000"
JOIN_CODE = "FGF-DEMO-0000"

# Weeks covered (Monday starts). 4 consecutive weeks ending 2026-08-03.
WEEKS = ["2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03"]

# ── Fictional player pseudos ────────────────────────────────────────────────
# Hand-picked sci-fi / galaxy-flavored names, all fictitious.
BASE_NAMES = [
    "Nova", "Orion", "Vega", "Atlas", "Rhea", "Zephyr", "Lyra", "Cyrus",
    "Nyx", "Draco", "Andra", "Mira", "Kael", "Sable", "Talon", "Echo",
    "Bex", "Iris", "Juno", "Kira", "Lobo", "Mako", "Nemo", "Onyx",
    "Pike", "Quill", "Rex", "Stella", "Tycho", "Umbra", "Vex", "Wren",
    "Xena", "Yuki", "Zeno", "Aria", "Blaze", "Cinder", "Dune", "Ember",
    "Frost", "Ghost", "Havoc", "Iron", "Jett", "Koda", "Lux", "Nash",
    "Odin", "Piper", "Rogue", "Slate", "Titan", "Ulan", "Viper", "Wolf",
    "Aster", "Bolt", "Comet", "Dagger", "Edge", "Flare", "Grim", "Halo",
    "Icarus", "Jagger", "Krux", "Lumen", "Moss", "Neon", "Ora", "Pulse",
    "Quasar", "Raid", "Solar", "Thor", "Ullr", "Volt", "Wisp", "Yara",
    "Zeal", "Axel", "Bane", "Chase", "Drift", "Emberlyn", "Fable", "Gale",
    "Hawk", "Ion", "Jinx", "Kestrel", "Lyric", "Maz", "Nix", "Obsidian",
    "Pry", "Rook", "Sable", "Trix", "Uno", "Vale", "Wraith", "Xylo",
]

def build_pseudos(n):
    """Build n unique fictional pseudos (mix of names, suffixes, decorations)."""
    out = []
    suffixes = ["", "", "", "X", "IX", "II", "VII", "88", "77", "99", "_o", "o_", "KOR", "solo"]
    deco = ["", "", "", "°", "°", "xX_", "_Xx"]
    i = 0
    while len(out) < n:
        base = BASE_NAMES[i % len(BASE_NAMES)]
        i += 1
        suf = random.choice(suffixes)
        d1 = random.choice(deco)
        d2 = "" if d1 else ""
        cand = d1 + base + suf + d2
        if cand and cand not in out:
            out.append(cand)
    return out

PSEUDOS = build_pseudos(200)

def pseudo_rng(pseudo):
    """Deterministic per-pseudo RNG so each player keeps stable stats across weeks."""
    return random.Random(hashlib.md5(pseudo.encode()).hexdigest())

def uid_for(pseudo, idx):
    # Dedicated high range (90_000_000+) so DEMO UIDs never collide with the
    # real tenants (max ~88M) and satisfy the prevent_duplicate_member_uid
    # trigger. Deterministic per pseudo.
    r = pseudo_rng(pseudo)
    return str(90000000 + r.randint(0, 9999999) + idx)

def power_for(pseudo):
    r = pseudo_rng(pseudo)
    # 8% elite whales (80–180M), 30% strong (40–80M), rest 12–40M
    p = r.random()
    if p < 0.08:
        return r.randint(80000000, 180000000)
    if p < 0.38:
        return r.randint(40000000, 80000000)
    return r.randint(12000000, 40000000)

def role_for(power):
    # Mirror ALPHA's shape: most R1/R2, few R3+, elite R4/R5.
    if power >= 120000000:
        return "R5"
    if power >= 90000000:
        return "R4"
    if power >= 65000000:
        return "R3"
    if power >= 35000000:
        return "R2"
    return "R1"

def tz_for(pseudo):
    r = pseudo_rng(pseudo)
    # Fictional guild mostly EU/NA: -8..+3, few outliers.
    return random.choice([-8, -7, -6, -5, -6, -5, -4, -3, -2, -1, 0, 0, 1, 1, 2, 3])

# ── Build members ───────────────────────────────────────────────────────────
members = []
for idx, pseudo in enumerate(PSEUDOS):
    power = power_for(pseudo)
    members.append({
        "pseudo": pseudo,
        "uid": uid_for(pseudo, idx),
        "power": power,
        "role": role_for(power),
        "tz": tz_for(pseudo),
    })

# ── SQL assembly ────────────────────────────────────────────────────────────
def sql_q(v):
    return "'" + str(v).replace("'", "''") + "'"

lines = []
lines.append("-- DEMO tenant seed (100% fictional)")
lines.append("begin;")

# Idempotent: drop existing DEMO data first (FK cascade removes participants).
# guild_config has no FK to guilds, so it is cleared explicitly.
lines.append(f"delete from public.event_status where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.guild_config where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.guild_members where guild = {sql_q(GUILD)};")

# 1. guilds
lines.append(
    "insert into public.guilds (id, created_at, subscription_type, subscription_end, server_number) "
    f"values ({sql_q(GUILD)}, now(), 'Unlimited', null, {sql_q(SERVER)}) "
    "on conflict (id) do update set server_number = excluded.server_number;"
)

# 2. guild_config: join code + coefficients
code_hash = hashlib.sha256(JOIN_CODE.upper().encode()).hexdigest()
lines.append(
    "insert into public.guild_config (guild, key, value, updated_at) values "
    f"({sql_q(GUILD)}, 'join_code_plain', {sql_q(JOIN_CODE)}, now()),"
    f"({sql_q(GUILD)}, 'join_code_hash', {sql_q(code_hash)}, now()),"
    f"({sql_q(GUILD)}, 'coeff_armsrace', '1', now()),"
    f"({sql_q(GUILD)}, 'coeff_dtr', '2', now()),"
    f"({sql_q(GUILD)}, 'coeff_gvg', '5', now()),"
    f"({sql_q(GUILD)}, 'coeff_shadowfront', '3', now()),"
    f"({sql_q(GUILD)}, 'coeff_svs', '5', now()),"
    f"({sql_q(GUILD)}, 'reserve_credit_pct', '50', now()) "
    "on conflict (guild, key) do update set value = excluded.value, updated_at = now();"
)

# 3. guild_members
mrows = []
for m in members:
    mrows.append(
        f"({sql_q(m['pseudo'])}, now(), {sql_q(m['uid'])}, {sql_q(GUILD)}, {m['power']}, "
        f"{sql_q(m['role'])}, {m['tz']})"
    )
lines.append(
    "insert into public.guild_members (pseudo, created_at, uid, guild, overall_power, role, timezone_offset) values\n"
    + ",\n".join(mrows)
    + f" on conflict (guild, pseudo) do update set uid = excluded.uid, overall_power = excluded.overall_power, role = excluded.role, timezone_offset = excluded.timezone_offset;"
)

# 4. events: for each week, build event_status (sessions) + event_participants.
#    Session ids follow the SaaS scheme (gm_event_session_id): SvS/GvG/Glory
#    use the ISO week, dated events use YYYYMMDD.

def iso_week_key(week):
    from datetime import date
    y, m, d = map(int, week.split("-"))
    iso = date(y, m, d).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"

def date_key(week):
    return week.replace("-", "")

def event_session_id(event_name, week):
    up = event_name.upper()
    if up == "SVS":
        return "SVS-" + iso_week_key(week)
    if up == "GVG":
        return "GVG-" + iso_week_key(week)
    if up == "GLORY":
        return "GLORY-" + iso_week_key(week)
    if up == "ARMS RACE STAGE A":
        return "ARA-" + date_key(week)
    if up == "ARMS RACE STAGE B":
        return "ARB-" + date_key(week)
    if up == "DEFEND TRADE ROUTE":
        return "DTR-" + date_key(week)
    if up == "SHADOWFRONT SQUAD 1":
        return "SF1-" + date_key(week)
    if up == "SHADOWFRONT SQUAD 2":
        return "SF2-" + date_key(week)
    return "EV-" + date_key(week)

def glory_score(pseudo, week):
    # Deterministic per (pseudo, week) so each week trends differently.
    key = pseudo + "|" + week
    r = random.Random(hashlib.md5(key.encode()).hexdigest())
    week_idx = WEEKS.index(week)
    # Slow upward drift week over week + per-player noise.
    drift = 1 + 0.18 * week_idx
    p = r.random()
    if p < 0.05:
        base = r.randint(90000000, 400000000)
    elif p < 0.30:
        base = r.randint(20000000, 90000000)
    else:
        base = r.randint(800000, 20000000)
    return int(base * drift * (0.82 + 0.36 * r.random()))

def event_participation(pseudo, week, base_rate):
    """Return (participated, score) — participation varies slightly per week."""
    key = pseudo + "|" + week
    r = random.Random(hashlib.md5(key.encode()).hexdigest())
    roll = r.random()
    if roll < base_rate:
        return (1, None)
    if roll < base_rate + 0.08:
        return (0, None)  # marked absent
    return (0, None)  # not present

# Glory: every week, all 200 players declare a Glory score under a GLORY-Wxx
# session id (matches gm_upsert_player_glory).
for week in WEEKS:
    gid = event_session_id("Glory", week)
    for m in members:
        lines.append(
            "insert into public.event_participants "
            "(event_name, week_start, pseudo, participated, score, session_id, guild, late, excused, appointed, sub_present) values "
            f"('Glory', {sql_q(week)}, {sql_q(m['pseudo'])}, 1, {glory_score(m['pseudo'], week)}, {sql_q(gid)}, {sql_q(GUILD)}, false, false, false, false) "
            f"on conflict (guild, event_name, session_id, pseudo) where session_id is not null do update set score = excluded.score, participated = 1;"
        )

# Weekly events with a session per week.
# event_status: one row per (guild, event_name) — keep the LAST week's session.
session_by_event = {}
for week in WEEKS:
    for ev, label, hour, rate, score_mode in [
        ("Defend Trade Route", "Defend Trade Route", 19, 0.78, "dtr"),
        ("ARMS RACE STAGE A", "ARMS RACE STAGE A", 17, 0.80, "arms"),
        ("ARMS RACE STAGE B", "ARMS RACE STAGE B", 17, 0.80, "arms"),
        ("SvS", "SvS", 14, 0.72, "svs"),
        ("GvG", "GvG", 10, 0.68, "gvg"),
    ]:
        sid = event_session_id(ev, week)
        session_by_event[ev] = sid
        for m in members:
            participated, _ = event_participation(m["pseudo"], week, rate)
            # GvG/SvS use participated only; DTR/ARMS may carry a score.
            score = None
            if score_mode == "dtr" and participated:
                score = 1  # DTR attendance only in ALPHA
            lines.append(
                "insert into public.event_participants "
                "(event_name, week_start, pseudo, participated, score, session_id, guild, late, excused, appointed, sub_present) values "
                f"({sql_q(ev)}, {sql_q(week)}, {sql_q(m['pseudo'])}, {participated}, {score if score is not None else 'null'}, "
                f"{sql_q(sid)}, {sql_q(GUILD)}, {random.choice(['false','false','true']) if not participated else 'false'}, "
                f"{random.choice(['false','false','false','true']) if not participated else 'false'}, false, false) "
                f"on conflict (guild, event_name, session_id, pseudo) where session_id is not null do update set participated = excluded.participated;"
            )

# Shadowfront: 2 squads on 2 of the 4 weeks (squad1 week2, squad2 week3).
shadow_sessions = {
    "Shadowfront Squad 1": ("2026-07-20", 18, 0),
    "Shadowfront Squad 2": ("2026-07-27", 23, 0),
}
for ev, (week, hour, minute) in shadow_sessions.items():
    sid = event_session_id(ev, week)
    session_by_event[ev] = sid
    # 30 assigned per squad
    squad_members = members[:30]
    for m in squad_members:
        participated, _ = event_participation(m["pseudo"], week, 0.85)
        lines.append(
            "insert into public.event_participants "
            "(event_name, week_start, pseudo, participated, score, session_id, guild, late, excused, appointed, sub_present) values "
            f"('Shadowfront', {sql_q(week)}, {sql_q(m['pseudo'])}, {participated}, null, {sql_q(sid)}, {sql_q(GUILD)}, "
            f"{'false' if participated else random.choice(['false','true'])}, "
            f"{'false' if participated else random.choice(['false','false','true'])}, false, false) "
            f"on conflict (guild, event_name, session_id, pseudo) where session_id is not null do update set participated = excluded.participated;"
        )

# event_status: mark each event with its latest session (inactive) so history shows dates.
for ev, label in [("Defend Trade Route", "Defend Trade Route"), ("ARMS RACE STAGE A", "ARMS RACE STAGE A"), ("ARMS RACE STAGE B", "ARMS RACE STAGE B"), ("SvS", "SvS"), ("GvG", "GvG"), ("Shadowfront Squad 1", "Shadowfront Squad 1"), ("Shadowfront Squad 2", "Shadowfront Squad 2")]:
    if ev not in session_by_event:
        continue
    sid = session_by_event[ev]
    lines.append(
        "insert into public.event_status (guild, event_name, is_active, updated_at, session_id, stage, start_at) values "
        f"({sql_q(GUILD)}, {sql_q(ev)}, false, now(), {sql_q(sid)}, "
        f"{sql_q('A') if 'STAGE A' in ev else (sql_q('B') if 'STAGE B' in ev else 'null')}, "
        f"null) "
        f"on conflict (guild, event_name) do update set session_id = excluded.session_id, start_at = excluded.start_at;"
    )

lines.append("commit;")
sys.stdout.write("\n".join(lines) + "\n")
