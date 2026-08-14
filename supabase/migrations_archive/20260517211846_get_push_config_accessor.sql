create or replace function public.get_push_config()
returns table (vapid_public text, vapid_private text, vapid_subject text, cron_secret text)
language sql
security definer
set search_path = public, vault
as $$
    select
        (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_public_key'),
        (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key'),
        (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_subject'),
        (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret');
$$;

revoke all on function public.get_push_config() from public, anon, authenticated;
grant execute on function public.get_push_config() to service_role;;
