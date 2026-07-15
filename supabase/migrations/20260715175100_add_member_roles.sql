-- Add role column to guild_members table
ALTER TABLE public.guild_members 
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'R1' CHECK (role IN ('R1', 'R2', 'R3', 'R4', 'R5'));

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
