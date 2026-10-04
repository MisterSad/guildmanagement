import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock getSupabaseClient before importing logger
const mockRpc = vi.fn().mockResolvedValue({ data: true, error: null });
const mockSupabase = {
  rpc: mockRpc,
};

vi.mock('../src/core/api/supabase', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Now import logger
import { logger } from '../src/core/logger/logger';

describe('TICKET-04 [OBS-01]: Client Error Reporting RPC & Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates that logger.error invokes gm_report_client_error RPC with expected params', async () => {
    logger.setContext({ tenantId: 'ALPHA', userId: 'user_12345' });

    logger.error('Something went wrong during sync', new Error('Network timeout'), { context: 'sync_test' });

    // Allow promise microtask to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [rpcName, rpcParams] = mockRpc.mock.calls[0];

    expect(rpcName).toBe('gm_report_client_error');
    expect(rpcParams.p_level).toBe('ERROR');
    expect(rpcParams.p_service).toBe('fgf-client');
    expect(rpcParams.p_guild).toBe('ALPHA');
    expect(rpcParams.p_user_identifier).toBe('user_12345');
    expect(rpcParams.p_message).toBe('Something went wrong during sync');
    expect(rpcParams.p_metadata).toEqual({ context: 'sync_test' });
    expect(rpcParams.p_error_details).toBeDefined();
    expect(rpcParams.p_error_details.message).toBe('Network timeout');
  });

  it('validates migration SQL file structure and security parameters', () => {
    const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260920110000_client_error_logging_rpc.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Check function name and parameters
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.gm_report_client_error(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO ''");

    // Check rate-limiting
    expect(sql).toContain('v_recent_count >= 15');
    expect(sql).toContain("interval '1 minute'");

    // Check grants
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.gm_report_client_error');
    expect(sql).toContain('TO authenticated, anon');
  });
});
