-- Password sign-in (gm_verify_password): bcrypt only, lockout, and the legacy
-- reversible copy (finding C0) is deleted at the first successful sign-in.
BEGIN;
SELECT tests.fixture();
-- A stand-in for the Vault key; the real one never leaves production.
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('gm_accounts_key', 'replay-only-test-key')
ON CONFLICT (name) DO UPDATE SET decrypted_secret = EXCLUDED.decrypted_secret;

SELECT tests.assert_eq((SELECT canonical_id FROM public.gm_verify_password('T_ADMIN_A', 'test-password-t_admin_a')), 't_admin_a'::text,
                       'the right password signs in, the identifier is case-insensitive');
SELECT tests.assert_eq((SELECT error FROM public.gm_verify_password('t_admin_a', 'wrong')), 'invalid_credentials'::text,
                       'a wrong password is refused');
SELECT tests.assert_eq((SELECT error FROM public.gm_verify_password('nobody', 'x')), 'invalid_credentials'::text,
                       'an unknown identifier gives the same answer');

-- Five failures lock the account.
SELECT public.gm_verify_password('t_admin_b', 'wrong') FROM generate_series(1, 5);
SELECT tests.assert_eq((SELECT is_locked FROM public.gm_verify_password('t_admin_b', 'test-password-t_admin_b')), true,
                       'five failures lock the account, even against the right password');

-- A legacy account with only the reversible copy.
UPDATE public.accounts
   SET password_hash = NULL,
       password_enc = extensions.pgp_sym_encrypt('legacy-pass', 'replay-only-test-key')
 WHERE id = 't_admin_c';
SELECT tests.assert_eq((SELECT canonical_id FROM public.gm_verify_password('t_admin_c', 'legacy-pass')), 't_admin_c'::text,
                       'a legacy account signs in with its old password');
SELECT tests.assert_eq((SELECT password_enc IS NULL AND password_hash IS NOT NULL FROM public.accounts WHERE id = 't_admin_c'), true,
                       'and its reversible copy is replaced by a hash');
SELECT tests.assert_eq((SELECT canonical_id FROM public.gm_verify_password('t_admin_c', 'legacy-pass')), 't_admin_c'::text,
                       'the hash then signs it in');

-- A Discord-claimed account (no credential at all) fails closed.
UPDATE public.accounts SET password_hash = NULL, password_enc = NULL WHERE id = 't_server';
SELECT tests.assert_eq((SELECT error FROM public.gm_verify_password('t_server', '')), 'invalid_credentials'::text,
                       'an account without credentials fails closed');

-- A reset writes the hash only.
SELECT public.gm_reset_account_password('t_admin_a', 'new-password-1');
SELECT tests.assert_eq((SELECT password_enc IS NULL FROM public.accounts WHERE id = 't_admin_a'), true, 'a reset writes no reversible copy');
SELECT tests.assert_eq((SELECT canonical_id FROM public.gm_verify_password('t_admin_a', 'new-password-1')), 't_admin_a'::text,
                       'the new password signs in');

ROLLBACK;
