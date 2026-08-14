CREATE OR REPLACE FUNCTION public.list_event_weeks()
RETURNS TABLE(week_start date)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT week_start
  FROM event_participants
  WHERE week_start IS NOT NULL
  ORDER BY week_start DESC;
$$;;
