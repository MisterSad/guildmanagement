-- Migration: Fix event_status primary key for multi-tenant support

-- 1. Drop old single-column primary key on event_status if present
ALTER TABLE public.event_status DROP CONSTRAINT IF EXISTS event_status_pkey CASCADE;

-- 2. Fill NULL guild values with 'ALPHA'
UPDATE public.event_status SET guild = 'ALPHA' WHERE guild IS NULL;
ALTER TABLE public.event_status ALTER COLUMN guild SET DEFAULT 'ALPHA';

-- 3. Create composite primary key on (guild, event_name)
ALTER TABLE public.event_status ADD CONSTRAINT event_status_pkey PRIMARY KEY (guild, event_name);
