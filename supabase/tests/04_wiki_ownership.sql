-- Migration wiki: only the authoring guild edits or deletes a page, and the
-- author is stamped by the server, never by the caller (audit SEC-08, DB-07).
BEGIN;
SELECT tests.fixture();

SELECT tests.login('t_admin_a');
INSERT INTO public.migration_wiki_pages (title, content, scope, server_number, created_by_pseudo, updated_by_pseudo)
VALUES ('Server plan', 'Written by TA', 'server', '9001', 'Forged author', 'Forged author');

SELECT tests.logout();
SELECT tests.assert_eq((SELECT created_by_account_id FROM public.migration_wiki_pages WHERE title = 'Server plan'), 't_admin_a'::text,
                       'the author is the caller, whatever the request said');
SELECT tests.assert_eq((SELECT owner_guild FROM public.migration_wiki_pages WHERE title = 'Server plan'), 'TA'::text,
                       'a server page belongs to the author''s guild');

-- Another guild of the same server reads it, but cannot change or delete it.
SELECT tests.login('t_admin_b');
SELECT tests.assert_eq((SELECT count(*) FROM public.migration_wiki_pages WHERE title = 'Server plan')::int, 1,
                       'a guild of the same server reads the server page');
SELECT tests.assert_eq(tests.rows($q$UPDATE public.migration_wiki_pages SET content = 'vandalised' WHERE title = 'Server plan'$q$), 0,
                       'another guild cannot edit the page');
SELECT tests.assert_eq(tests.rows($q$DELETE FROM public.migration_wiki_pages WHERE title = 'Server plan'$q$), 0,
                       'another guild cannot delete the page');

-- A guild of another server does not even see it.
SELECT tests.login('t_admin_c');
SELECT tests.assert_eq((SELECT count(*) FROM public.migration_wiki_pages WHERE title = 'Server plan')::int, 0,
                       'a guild of another server does not see the page');

-- The author's guild edits it; ownership cannot be moved.
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(tests.rows($q$UPDATE public.migration_wiki_pages SET content = 'v2' WHERE title = 'Server plan'$q$), 1,
                       'the authoring guild edits its page');
SELECT tests.assert_raises($q$UPDATE public.migration_wiki_pages SET owner_guild = 'TB' WHERE title = 'Server plan'$q$,
                           'ownership is not writable from a browser', '42501');
SELECT tests.assert_raises($q$UPDATE public.migration_wiki_pages SET scope = 'guild' WHERE title = 'Server plan'$q$,
                           'the scope is not writable from a browser', '42501');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT owner_guild || '/' || scope || '/' || content || '/' || updated_by_account_id FROM public.migration_wiki_pages WHERE title = 'Server plan'),
                       'TA/server/v2/t_admin_a'::text, 'the edit is stamped with its author');

ROLLBACK;
