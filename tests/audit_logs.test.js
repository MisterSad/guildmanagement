import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuditView } from '../src/modules/audit/audit-view';

// Mock Supabase client
const mockSelect = vi.fn();
const mockOrder = vi.fn();
const mockRange = vi.fn();
const mockEq = vi.fn();
const mockOr = vi.fn();
const mockGte = vi.fn();

const mockQueryBuilder = {
  select: mockSelect,
  order: mockOrder,
  range: mockRange,
  eq: mockEq,
  or: mockOr,
  gte: mockGte,
};

// Chain builder
mockSelect.mockReturnValue(mockQueryBuilder);
mockEq.mockReturnValue(mockQueryBuilder);
mockOr.mockReturnValue(mockQueryBuilder);
mockOrder.mockReturnValue(mockQueryBuilder);
mockGte.mockReturnValue(mockQueryBuilder);

const mockSupabase = {
  from: vi.fn(() => mockQueryBuilder),
};

vi.mock('../src/core/api/supabase', () => ({
  getSupabaseClient: () => mockSupabase,
  escapeHTML: (str) => (str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''),
}));

describe('AuditService and Player Portal Logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters audit logs by action_type, guild, and search query', async () => {
    const mockLogs = [
      {
        id: '1',
        action_type: 'score_submission',
        pseudo: 'Ares_Actual',
        uid: '90000001',
        server_number: '0000',
        guild: 'ALPHA',
        message: 'Submitted scores for SvS [SVS-2026-W34]: Prep: 15,000,000, PvP: 42,000,000',
        created_at: new Date().toISOString(),
        level: 'INFO',
        service: 'member-portal',
        metadata: { score_prep: 15000000, score_pvp: 42000000 }
      }
    ];

    mockRange.mockResolvedValueOnce({ data: mockLogs, count: 1, error: null });

    const result = await AuditService.getLogs({
      action_type: 'score_submission',
      guild: 'ALPHA',
      search: 'Ares_Actual'
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('system_audit_logs');
    expect(mockEq).toHaveBeenCalledWith('action_type', 'score_submission');
    expect(mockEq).toHaveBeenCalledWith('guild', 'ALPHA');
    expect(mockOr).toHaveBeenCalled();
    expect(result.logs.length).toBe(1);
    expect(result.logs[0].pseudo).toBe('Ares_Actual');
    expect(result.logs[0].action_type).toBe('score_submission');
  });

  it('correctly aggregates 24h KPI statistics for Player Portal submissions', async () => {
    const mockStatsData = [
      { action_type: 'score_submission', pseudo: 'Player1', uid: 'U1', level: 'INFO', duration_ms: 120 },
      { action_type: 'score_submission', pseudo: 'Player2', uid: 'U2', level: 'INFO', duration_ms: 80 },
      { action_type: 'metrics_update', pseudo: 'Player1', uid: 'U1', level: 'INFO', duration_ms: 50 },
      { action_type: 'power_update', pseudo: 'Player3', uid: 'U3', level: 'INFO', duration_ms: 40 },
      { action_type: 'glory_update', pseudo: 'Player4', uid: 'U4', level: 'INFO', duration_ms: 60 },
      { action_type: 'unknown', pseudo: 'System', uid: null, level: 'ERROR', duration_ms: 200 },
    ];

    mockGte.mockResolvedValueOnce({ data: mockStatsData, error: null });

    const stats = await AuditService.getStats();

    expect(stats.total24h).toBe(6);
    expect(stats.scores24h).toBe(2);
    expect(stats.metrics24h).toBe(3); // metrics_update + power_update + glory_update
    expect(stats.uniquePlayers24h).toBe(4); // U1, U2, U3, U4
    expect(stats.errors24h).toBe(1);
    expect(stats.avgDurationMs).toBe(91.7); // (120+80+50+40+60+200)/6 = 550/6 ≈ 91.667 -> 91.7
  });

  it('populates guild dropdown with all 13 tenant guilds', () => {
    document.body.innerHTML = `
      <select id="filter-logs-guild">
        <option value="ALL">All Guilds</option>
      </select>
    `;

    AuditView.populateGuildSelect();

    const select = document.getElementById('filter-logs-guild');
    expect(select.children.length).toBe(14); // 1 (ALL) + 13 guilds
    expect(select.querySelector('option[value="ALPHA"]')).not.toBeNull();
    expect(select.querySelector('option[value="OMEGA"]')).not.toBeNull();
    expect(select.querySelector('option[value="DEMO"]')).not.toBeNull();
  });
});
