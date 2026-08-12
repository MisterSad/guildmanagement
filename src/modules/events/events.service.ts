/**
 * src/modules/events/events.service.ts
 *
 * ES Module TypeScript service managing active event sessions,
 * score submissions, and auto-enrollment helpers.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { buildEventSessionId, eventScoringKey } from '../../core/config/events';
import { EventStatus, EventParticipant } from '../../types/database';

export class EventsService {
  public static async getActiveSessions(guild: string): Promise<EventStatus[]> {
    const supabase = getSupabaseClient();
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('event_status')
      .select('*')
      .eq('guild', guild)
      .eq('active', true);

    if (error) {
      console.error('Error fetching active event sessions:', error);
      return [];
    }

    return (data || []) as EventStatus[];
  }

  public static async startEventSession(
    eventName: string,
    guild: string,
    startAt?: string
  ): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const activeSessions = await this.getActiveSessions(guild);
    const existingIds = activeSessions.map((s) => s.session_id);
    const sessionId = buildEventSessionId(eventName, startAt, existingIds);

    const { data, error } = await supabase
      .from('event_status')
      .upsert({
        event_name: eventName,
        guild,
        session_id: sessionId,
        active: true,
        start_at: startAt || new Date().toISOString()
      }, { onConflict: 'guild,event_name' })
      .select()
      .single();

    if (error) {
      console.error('Error starting event session:', error);
      return { ok: false, error: error.message };
    }

    return { ok: true, session_id: data.session_id };
  }

  public static async submitParticipantScore(
    participant: EventParticipant
  ): Promise<{ ok: boolean; error?: string }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { error } = await supabase
      .from('event_participants')
      .upsert(participant, { onConflict: 'guild,event_name,session_id,pseudo' });

    if (error) {
      console.error('Error submitting participant score:', error);
      return { ok: false, error: error.message };
    }

    return { ok: true };
  }
}
