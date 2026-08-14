/**
 * src/modules/events/events.service.ts
 *
 * ES Module TypeScript service managing active event sessions,
 * score submissions, and auto-enrollment helpers.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { buildEventSessionId } from '../../core/config/events';
import { EventStatus, EventParticipant } from '../../types/database';
import { logger } from '../../core/logger/logger';

export class EventsService {
  public static async getActiveSessions(guild: string): Promise<EventStatus[]> {
    const supabase = getSupabaseClient();
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('event_status')
      .select('*')
      .eq('guild', guild)
      .eq('is_active', true);

    if (error) {
      logger.error('Error fetching active event sessions', error, { guild });
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
        is_active: true,
        start_at: startAt || new Date().toISOString()
      }, { onConflict: 'guild,event_name' })
      .select()
      .single();

    if (error) {
      logger.error('Error starting event session', error, { eventName, guild, sessionId });
      return { ok: false, error: error.message };
    }

    logger.info('Event session started successfully', { eventName, guild, sessionId });
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
      logger.error('Error submitting participant score', error, { pseudo: participant.pseudo, eventName: participant.event_name });
      return { ok: false, error: error.message };
    }

    return { ok: true };
  }
}
