-- Roster guards enforced by the database: banned players stay out, a game UID
-- belongs to one guild, the R5 cannot be removed.
BEGIN;
SELECT tests.fixture();

INSERT INTO public.banned_players (guild, uid, pseudo, reason) VALUES ('TA', '7999999', 'Troll', 'test');

SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$INSERT INTO public.guild_members (guild, pseudo, uid) VALUES ('TA', 'TrollAgain', '7999999')$q$,
                           'a banned UID cannot rejoin the guild that banned it');
SELECT tests.assert_raises($q$INSERT INTO public.guild_members (guild, pseudo, uid) VALUES ('TA', 'Copycat', '7000101')$q$,
                           'a UID already in another guild cannot be added');
SELECT tests.assert_eq(tests.rows($q$INSERT INTO public.guild_members (guild, pseudo, uid) VALUES ('TA', 'Newcomer', '7000009')$q$), 1,
                       'a fresh UID is accepted');
SELECT tests.assert_raises($q$DELETE FROM public.guild_members WHERE guild = 'TA' AND pseudo = 'Alpha1'$q$,
                           'the R5 cannot be deleted');

-- The ban is per guild: another guild may still recruit that UID.
SELECT tests.login('t_admin_b');
SELECT tests.assert_eq(tests.rows($q$INSERT INTO public.guild_members (guild, pseudo, uid) VALUES ('TB', 'Troll', '7999999')$q$), 1,
                       'a ban applies to the guild that issued it only');

ROLLBACK;
