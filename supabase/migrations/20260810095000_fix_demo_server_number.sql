-- 20260810090000_fix_demo_server_number.sql
-- Fixes server_number for DEMO guild from '#0000' to '0000' and strips leading '#' from any guild's server_number.

update public.guilds
set server_number = regexp_replace(server_number, '^#+', '')
where server_number like '#%';
