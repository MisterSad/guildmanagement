-- Migration: Set server_number for all guilds
-- Server #1058: ALPHA, OMEGA, IMK
-- Server #1064: BABE, YARR

UPDATE public.guilds SET server_number = '1058' WHERE id = 'ALPHA';
UPDATE public.guilds SET server_number = '1058' WHERE id = 'OMEGA';
UPDATE public.guilds SET server_number = '1058' WHERE id = 'IMK';
UPDATE public.guilds SET server_number = '1064' WHERE id = 'BABE';
UPDATE public.guilds SET server_number = '1064' WHERE id = 'YARR';
