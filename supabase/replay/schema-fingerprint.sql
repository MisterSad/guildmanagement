-- supabase/replay/schema-fingerprint.sql
--
-- One line per object of the `public` schema, `kind|name|digest`, sorted.
-- Run it on production (read-only) and on a database built by
-- scripts/replay-migrations.sh: identical output means the migration chain
-- builds production. tests/fixtures/schema_fingerprint.txt is production's,
-- and the CI replay job diffs against it.
--
-- Read-only. Safe on production.

WITH objs AS (
  -- Columns: type, nullability, default.
  SELECT 'column' AS kind,
         c.table_name || '.' || c.column_name AS name,
         md5(concat_ws('|', c.data_type, c.udt_name, c.is_nullable, c.column_default)) AS digest
    FROM information_schema.columns c
    JOIN pg_class t ON t.relname = c.table_name AND t.relnamespace = 'public'::regnamespace AND t.relkind = 'r'
   WHERE c.table_schema = 'public'
  UNION ALL
  -- Tables: RLS flags and grants.
  SELECT 'table', t.relname,
         md5(concat_ws('|', t.relrowsecurity, t.relforcerowsecurity,
             (SELECT string_agg(g.grantee || ':' || g.privilege_type, ',' ORDER BY g.grantee, g.privilege_type)
                FROM information_schema.role_table_grants g
               WHERE g.table_schema = 'public' AND g.table_name = t.relname
                 AND g.grantee IN ('anon', 'authenticated', 'service_role'))))
    FROM pg_class t WHERE t.relnamespace = 'public'::regnamespace AND t.relkind = 'r'
  UNION ALL
  -- Column-level grants to the API roles.
  SELECT 'column_grant', g.table_name || '.' || g.column_name,
         md5(string_agg(g.grantee || ':' || g.privilege_type, ',' ORDER BY g.grantee, g.privilege_type))
    FROM information_schema.column_privileges g
   WHERE g.table_schema = 'public' AND g.grantee IN ('anon', 'authenticated')
   GROUP BY g.table_name, g.column_name
  UNION ALL
  SELECT 'constraint', k.conrelid::regclass::text || '.' || k.conname, md5(pg_get_constraintdef(k.oid) || k.condeferrable || k.condeferred)
    FROM pg_constraint k WHERE k.connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'index', i.indexname, md5(i.indexdef)
    FROM pg_indexes i WHERE i.schemaname = 'public'
  UNION ALL
  -- Functions: body, configuration, security, and who may execute.
  SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(concat_ws('|', p.prosrc, p.prosecdef, p.provolatile, array_to_string(p.proconfig, ','),
             pg_get_function_result(p.oid),
             (SELECT string_agg(coalesce(r.rolname, 'PUBLIC'), ',' ORDER BY coalesce(r.rolname, 'PUBLIC'))
                FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                LEFT JOIN pg_roles r ON r.oid = a.grantee
               WHERE a.privilege_type = 'EXECUTE' AND coalesce(r.rolname, '') <> 'postgres')))
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'policy', pol.tablename || '.' || pol.policyname,
         md5(concat_ws('|', pol.permissive, array_to_string(pol.roles, ','), pol.cmd, pol.qual, pol.with_check))
    FROM pg_policies pol WHERE pol.schemaname = 'public'
  UNION ALL
  SELECT 'trigger', tg.tgrelid::regclass::text || '.' || tg.tgname, md5(pg_get_triggerdef(tg.oid))
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT tg.tgisinternal
  UNION ALL
  SELECT 'view', v.viewname, md5(v.definition) FROM pg_views v WHERE v.schemaname = 'public'
)
SELECT kind || '|' || name || '|' || digest FROM objs ORDER BY 1;
