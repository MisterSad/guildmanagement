/**
 * src/core/store/store.ts
 *
 * Centralized, reactive state store with a lightweight Pub/Sub pattern.
 */

import { AccountRole, GuildMember, EventStatus } from '../../types/database';

export interface AppState {
  currentGuild: string;
  guildRestriction: string | null;
  role: AccountRole;
  userIdentifier: string | null;
  accountId: string | null;
  members: GuildMember[];
  activeEvents: EventStatus[];
  isLoading: boolean;
}

type Listener = (state: AppState) => void;

const initialState: AppState = {
  currentGuild: typeof localStorage !== 'undefined' ? localStorage.getItem('gm_current_guild') || 'ALPHA' : 'ALPHA',
  guildRestriction: typeof localStorage !== 'undefined' ? localStorage.getItem('gm_guild_restriction') : null,
  role: 'member',
  userIdentifier: null,
  accountId: null,
  members: [],
  activeEvents: [],
  isLoading: false
};

class Store {
  private state: AppState;
  private listeners: Set<Listener>;

  constructor() {
    this.state = { ...initialState };
    this.listeners = new Set();
  }

  public getState(): AppState {
    return { ...this.state };
  }

  public setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener(this.getState());
      } catch (e) {
        console.error('Error in store listener:', e);
      }
    });
  }

  public setCurrentGuild(guild: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('gm_current_guild', guild);
    }
    this.setState({ currentGuild: guild });
  }

  public setMembers(members: GuildMember[]): void {
    this.setState({ members });
  }

  public setActiveEvents(events: EventStatus[]): void {
    this.setState({ activeEvents: events });
  }
}

export const appStore = new Store();
