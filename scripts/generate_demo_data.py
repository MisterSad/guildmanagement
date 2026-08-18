#!/usr/bin/env python3
"""
generate_demo_data.py — Seed the fictional DEMO tenant for public previews & screenshots.

Creates:
  - guilds row (id = DEMO, server_number = 0000, subscription = Unlimited, payments_disabled = true)
  - accounts (DemoAdmin: guild_admin, DemoPlayer: member)
  - guild_config (join code + coeffs)
  - 60 fictional guild_members with full 7 military metrics (tech, champion, crew, flagship, fleet, glory, power)
  - 5 weeks of Glory + events (DTR, ARMS A/B, SvS, GvG, Shadowfront) with prep/pvp scores
  - player_metrics_history snapshots across all weeks
  - weekly_scores calculations
  - shadowfront squads & signups
  - sample sanctions, absences, and name history

Usage:
  python3 scripts/generate_demo_data.py | supabase db query --linked
"""

import hashlib
import random
import sys
from datetime import date, timedelta

random.seed(20260808)

GUILD = "DEMO"
SERVER = "0000"
JOIN_CODE = "FGF-DEMO-0000"

# Dynamic 5 consecutive weeks ending with current week
today = date.today()
monday = today - timedelta(days=today.weekday())
WEEKS = [(monday - timedelta(weeks=i)).strftime("%Y-%m-%d") for i in range(4, -1, -1)]

# ── Fictional player pseudos ────────────────────────────────────────────────
BASE_NAMES = [
    "Nova", "Valkyrie", "Orion", "Vega", "Atlas", "Rhea", "Zephyr", "Lyra", "Cyrus",
    "Nyx", "Draco", "Andra", "Mira", "Kael", "Sable", "Talon", "Echo", "Bex",
    "Iris", "Juno", "Kira", "Lobo", "Mako", "Nemo", "Onyx", "Pike", "Quill",
    "Rex", "Stella", "Tycho", "Umbra", "Vex", "Wren", "Xena", "Yuki", "Zeno",
    "Aria", "Blaze", "Cinder", "Dune", "Ember", "Frost", "Ghost", "Havoc", "Iron",
    "Jett", "Koda", "Lux", "Nash", "Odin", "Piper", "Rogue", "Slate", "Titan",
    "Ulan", "Viper", "Wolf", "Aster", "Bolt", "Comet"
]

def pseudo_rng(pseudo):
    return random.Random(hashlib.md5(pseudo.encode()).hexdigest())

def uid_for(pseudo, idx):
    return str(90000001 + idx)

def power_metrics_for(pseudo, idx):
    if idx == 0:
        power = 168000000
        role = "R5"
        tz = 1
    elif idx < 5:
        power = 120000000 - (idx * 6000000)
        role = "R4"
        tz = [2, -5, 0, 1][idx - 1]
    elif idx < 18:
        power = 78000000 - ((idx - 5) * 2500000)
        role = "R3"
        tz = (idx % 8) - 5
    elif idx < 42:
        power = 42000000 - ((idx - 18) * 900000)
        role = "R2"
        tz = (idx % 9) - 6
    else:
        power = 20000000 - ((idx - 42) * 500000)
        role = "R1"
        tz = (idx % 6) - 3

    tech = int(power * (0.35 if idx < 5 else (0.33 if idx < 18 else (0.31 if idx < 42 else 0.28))))
    champ = int(power * (0.25 if idx < 5 else (0.24 if idx < 18 else (0.22 if idx < 42 else 0.20))))
    crew = int(power * (0.22 if idx < 5 else (0.23 if idx < 18 else (0.24 if idx < 42 else 0.26))))
    flag = int(power * (0.14 if idx < 5 else (0.12 if idx < 18 else (0.10 if idx < 42 else 0.08))))
    fleet = int(power * (0.85 if idx < 5 else (0.80 if idx < 18 else (0.75 if idx < 42 else 0.70))))
    glory = int(power * (2.2 if idx < 5 else (1.8 if idx < 18 else (1.5 if idx < 42 else 1.2))))

    return {
        "pseudo": pseudo,
        "uid": uid_for(pseudo, idx),
        "overall_power": power,
        "tech_power": tech,
        "champion_power": champ,
        "crew_power": crew,
        "flagship_power": flag,
        "fleet_rating": fleet,
        "glory_score": glory,
        "role": role,
        "tz": tz
    }

members = [power_metrics_for(name, i) for i, name in enumerate(BASE_NAMES)]

def sql_q(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"

def iso_week_key(week_str):
    y, m, d = map(int, week_str.split("-"))
    iso = date(y, m, d).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"

def date_key(d_obj):
    return d_obj.strftime("%Y%m%d")

def event_session_id(event_name, week_str, day_offset=0):
    y, m, d = map(int, week_str.split("-"))
    event_date = date(y, m, d) + timedelta(days=day_offset)
    up = event_name.upper()
    if up == "SVS":
        return "SVS-" + iso_week_key(week_str)
    if up == "GVG":
        return "GVG-" + iso_week_key(week_str)
    if up == "GLORY":
        return "GLORY-" + iso_week_key(week_str)
    if up == "ARMS RACE STAGE A":
        return "ARA-" + date_key(event_date)
    if up == "ARMS RACE STAGE B":
        return "ARB-" + date_key(event_date)
    if up == "DEFEND TRADE ROUTE":
        return "DTR-" + date_key(event_date)
    if up == "SHADOWFRONT SQUAD 1":
        return "SF1-" + date_key(event_date)
    if up == "SHADOWFRONT SQUAD 2":
        return "SF2-" + date_key(event_date)
    return "EV-" + date_key(event_date)

lines = []
lines.append("-- DEMO tenant seed (100% fictional & dynamic)")
lines.append("begin;")

# Clean existing DEMO data
lines.append(f"delete from public.player_metrics_history where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.shadowfront_signups where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.shadowfront_squads where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.weekly_scores where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.sanctions where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.banned_players where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.player_absences where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.player_name_history where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.player_push_prefs where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.push_subscriptions where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.event_reminders_sent where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.discord_notifications_sent where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.event_participants where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.event_status where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.guild_members where guild = {sql_q(GUILD)};")
lines.append(f"delete from public.guild_config where guild = {sql_q(GUILD)};")

# Guilds
lines.append(
    f"insert into public.guilds (id, server_number, subscription_type, subscription_end, payments_disabled, created_at) "
    f"values ({sql_q(GUILD)}, {sql_q(SERVER)}, 'Unlimited', null, true, now()) "
    f"on conflict (id) do update set server_number = excluded.server_number, payments_disabled = true;"
)

# Accounts
lines.append(
    f"insert into public.accounts (id, role, guild, server_number, status, uid, password_enc, created_at) values "
    f"('DemoAdmin', 'guild_admin', {sql_q(GUILD)}, {sql_q(SERVER)}, 'active', null, "
    f"extensions.pgp_sym_encrypt('demo1234', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')), now()), "
    f"('DemoPlayer', 'member', {sql_q(GUILD)}, {sql_q(SERVER)}, 'active', '90000002', "
    f"extensions.pgp_sym_encrypt('demo1234', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')), now()) "
    f"on conflict (id) do update set "
    f"role = excluded.role, guild = excluded.guild, server_number = excluded.server_number, "
    f"status = 'active', uid = excluded.uid, password_enc = excluded.password_enc;"
)

# Guild config
code_hash = hashlib.sha256(JOIN_CODE.encode()).hexdigest()
lines.append(
    f"insert into public.guild_config (guild, key, value, updated_at) values "
    f"({sql_q(GUILD)}, 'join_code_plain', {sql_q(JOIN_CODE)}, now()), "
    f"({sql_q(GUILD)}, 'join_code_hash', {sql_q(code_hash)}, now()), "
    f"({sql_q(GUILD)}, 'coeff_armsrace', '1', now()), "
    f"({sql_q(GUILD)}, 'coeff_dtr', '2', now()), "
    f"({sql_q(GUILD)}, 'coeff_gvg', '5', now()), "
    f"({sql_q(GUILD)}, 'coeff_shadowfront', '3', now()), "
    f"({sql_q(GUILD)}, 'coeff_svs', '5', now()), "
    f"({sql_q(GUILD)}, 'reserve_credit_pct', '50', now()) "
    f"on conflict (guild, key) do update set value = excluded.value, updated_at = now();"
)

# Guild members
mrows = []
for m in members:
    mrows.append(
        f"({sql_q(m['uid'])}, {sql_q(m['pseudo'])}, {sql_q(GUILD)}, {m['overall_power']}, "
        f"{m['tech_power']}, {m['champion_power']}, {m['crew_power']}, {m['flagship_power']}, "
        f"{m['fleet_rating']}, {m['glory_score']}, {sql_q(m['role'])}, {m['tz']}, now(), now(), now() - interval '60 days')"
    )
lines.append(
    "insert into public.guild_members (uid, pseudo, guild, overall_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, role, timezone_offset, power_updated_at, metrics_updated_at, created_at) values\n"
    + ",\n".join(mrows)
    + f" on conflict (guild, pseudo) do update set overall_power = excluded.overall_power, tech_power = excluded.tech_power, champion_power = excluded.champion_power, crew_power = excluded.crew_power, flagship_power = excluded.flagship_power, fleet_rating = excluded.fleet_rating, glory_score = excluded.glory_score;"
)

# History & Event Participants across 5 weeks
for w_idx, week in enumerate(WEEKS):
    drift = 0.82 + (0.045 * (w_idx + 1))
    
    # 1. player_metrics_history
    hrows = []
    for m in members:
        hrows.append(
            f"({sql_q(GUILD)}, {sql_q(m['pseudo'])}, {sql_q(week)}, {int(m['overall_power'] * drift)}, "
            f"{int(m['tech_power'] * drift)}, {int(m['champion_power'] * drift)}, {int(m['crew_power'] * drift)}, "
            f"{int(m['flagship_power'] * drift)}, {int(m['fleet_rating'] * drift)}, {int(m['glory_score'] * drift)}, {sql_q(week)}::timestamp + time '12:00:00')"
        )
    lines.append(
        "insert into public.player_metrics_history (guild, pseudo, week_start, total_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, created_at) values\n"
        + ",\n".join(hrows)
        + " on conflict (guild, pseudo, week_start) do update set total_power = excluded.total_power, tech_power = excluded.tech_power;"
    )

    # 2. Glory
    glory_sid = event_session_id("Glory", week)
    grows = []
    for m in members:
        grows.append(
            f"('Glory', {sql_q(GUILD)}, {sql_q(m['pseudo'])}, {sql_q(glory_sid)}, {sql_q(week)}, 1, {int(m['glory_score'] * drift)}, false, false, false, false)"
        )
    lines.append(
        "insert into public.event_participants (event_name, guild, pseudo, session_id, week_start, participated, score, late, excused, appointed, sub_present) values\n"
        + ",\n".join(grows)
        + " on conflict (guild, event_name, session_id, pseudo) do update set score = excluded.score, participated = 1;"
    )

    # 3. SvS & GvG
    svs_sid = event_session_id("SvS", week)
    gvg_sid = event_session_id("GvG", week)
    srows = []
    gvrows = []
    for idx, m in enumerate(members):
        part = 0 if (idx % 7 == 0 and idx > 10) else 1
        prep = int((m['overall_power'] / 350) * (0.8 + (idx % 5) * 0.1)) if part == 1 else 0
        pvp = int((m['overall_power'] / 180) * (0.7 + (idx % 6) * 0.1)) if part == 1 else 0
        srows.append(
            f"('SvS', {sql_q(GUILD)}, {sql_q(m['pseudo'])}, {sql_q(svs_sid)}, {sql_q(week)}, {part}, {prep + pvp}, {prep}, {pvp}, "
            f"{'true' if (part == 1 and idx % 9 == 0) else 'false'}, {'true' if (part == 0 and idx % 14 == 0) else 'false'}, false, false)"
        )

        gvg_part = 0 if (idx % 8 == 0 and idx > 12) else 1
        gvg_prep = int((m['overall_power'] / 400) * (0.8 + (idx % 4) * 0.1)) if gvg_part == 1 else 0
        gvg_pvp = int((m['overall_power'] / 220) * (0.7 + (idx % 5) * 0.1)) if gvg_part == 1 else 0
        gvrows.append(
            f"('GvG', {sql_q(GUILD)}, {sql_q(m['pseudo'])}, {sql_q(gvg_sid)}, {sql_q(week)}, {gvg_part}, {gvg_prep + gvg_pvp}, {gvg_prep}, {gvg_pvp}, "
            f"{'true' if (gvg_part == 1 and idx % 11 == 0) else 'false'}, {'true' if (gvg_part == 0 and idx % 16 == 0) else 'false'}, false, false)"
        )
    lines.append(
        "insert into public.event_participants (event_name, guild, pseudo, session_id, week_start, participated, score, score_prep, score_pvp, late, excused, appointed, sub_present) values\n"
        + ",\n".join(srows)
        + " on conflict (guild, event_name, session_id, pseudo) do update set participated = excluded.participated, score = excluded.score;"
    )
    lines.append(
        "insert into public.event_participants (event_name, guild, pseudo, session_id, week_start, participated, score, score_prep, score_pvp, late, excused, appointed, sub_present) values\n"
        + ",\n".join(gvrows)
        + " on conflict (guild, event_name, session_id, pseudo) do update set participated = excluded.participated, score = excluded.score;"
    )

    # 4. Weekly Scores
    wsrows = []
    for idx, m in enumerate(members):
        score_20 = round(min(20.0, 15.0 + ((idx % 5) * 1.0) + (0.5 * (w_idx + 1))), 1)
        wsrows.append(
            f"({sql_q(GUILD)}, {sql_q(week)}, {sql_q(m['pseudo'])}, {score_20}, {6 - (idx % 2)}, 6, {int(m['glory_score'] * drift)}, {sql_q(week)}::timestamp + time '23:59:00')"
        )
    lines.append(
        "insert into public.weekly_scores (guild, week_start, pseudo, score_20, events_done, events_total, glory_score, computed_at) values\n"
        + ",\n".join(wsrows)
        + " on conflict (guild, week_start, pseudo) do update set score_20 = excluded.score_20, events_done = excluded.events_done, glory_score = excluded.glory_score;"
    )

# Current week event status
cur_week = WEEKS[-1]
lines.append(
    f"insert into public.event_status (guild, event_name, is_active, stage, session_id, start_at, updated_at) values "
    f"({sql_q(GUILD)}, 'Glory', true, null, {sql_q(event_session_id('Glory', cur_week))}, {sql_q(cur_week)}::timestamp, now()), "
    f"({sql_q(GUILD)}, 'SvS', false, null, {sql_q(event_session_id('SvS', cur_week))}, {sql_q(cur_week)}::timestamp + interval '5 days 14 hours', now()), "
    f"({sql_q(GUILD)}, 'GvG', false, null, {sql_q(event_session_id('GvG', cur_week))}, {sql_q(cur_week)}::timestamp + interval '4 days 10 hours', now()), "
    f"({sql_q(GUILD)}, 'Defend Trade Route', false, null, {sql_q(event_session_id('Defend Trade Route', cur_week, 2))}, {sql_q(cur_week)}::timestamp + interval '2 days 19 hours', now()), "
    f"({sql_q(GUILD)}, 'ARMS RACE STAGE A', false, 'A', {sql_q(event_session_id('ARMS RACE STAGE A', cur_week, 3))}, {sql_q(cur_week)}::timestamp + interval '3 days 17 hours', now()), "
    f"({sql_q(GUILD)}, 'ARMS RACE STAGE B', false, 'B', {sql_q(event_session_id('ARMS RACE STAGE B', cur_week, 4))}, {sql_q(cur_week)}::timestamp + interval '4 days 17 hours', now()), "
    f"({sql_q(GUILD)}, 'Shadowfront Squad 1', false, null, {sql_q(event_session_id('Shadowfront Squad 1', cur_week, 5))}, {sql_q(cur_week)}::timestamp + interval '5 days 18 hours', now()), "
    f"({sql_q(GUILD)}, 'Shadowfront Squad 2', false, null, {sql_q(event_session_id('Shadowfront Squad 2', cur_week, 5))}, {sql_q(cur_week)}::timestamp + interval '5 days 23 hours', now()) "
    f"on conflict (guild, event_name, session_id) do update set is_active = excluded.is_active, updated_at = now();"
)

# Sanctions & Absences
lines.append(
    f"insert into public.sanctions (guild, pseudo, comment, created_by, created_at) values "
    f"({sql_q(GUILD)}, 'Koda', 'Warning: Missed SvS battle without prior notice.', 'DemoAdmin', now() - interval '6 days'), "
    f"({sql_q(GUILD)}, 'Piper', 'Warning: Arrived 25 minutes late for GvG coordinate strike.', 'DemoAdmin', now() - interval '12 days'), "
    f"({sql_q(GUILD)}, 'Viper', 'Demotion: Inactivity during scheduled Shadowfront deployment.', 'DemoAdmin', now() - interval '18 days');"
)

lines.append("commit;")
sys.stdout.write("\n".join(lines) + "\n")
