ALTER TABLE public.event_status ADD COLUMN IF NOT EXISTS start_at timestamptz;

COMMENT ON COLUMN public.event_status.start_at IS 'Planned UTC start time of the event occurrence (set at launch for Shadowfront / Defend Trade Route / Arms Race). Drives the Overview upcoming list and future reminders.';

NOTIFY pgrst, 'reload schema';;
