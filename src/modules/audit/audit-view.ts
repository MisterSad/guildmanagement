/**
 * src/modules/audit/audit-view.ts
 *
 * Interactive System Audit Logs & Diagnostic View for Super Admins.
 * Real-time event stream, filters, summary metrics, and detail inspect modal.
 */

import { AuditService } from './audit.service';
import { escapeHTML } from '../../core/api/supabase';
import { SystemAuditLog } from '../../types/database';

let autoRefreshInterval: any = null;

function formatTimeAgo(isoString: string): string {
  if (!isoString) return '-';
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function getLevelBadge(level: string): string {
  switch (level) {
    case 'FATAL':
    case 'ERROR':
      return `<span class="gm-badge" style="background:rgba(239, 68, 68, 0.15); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px;">${escapeHTML(level)}</span>`;
    case 'WARN':
      return `<span class="gm-badge" style="background:rgba(245, 158, 11, 0.15); color:#f59e0b; border:1px solid rgba(245, 158, 11, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px;">${escapeHTML(level)}</span>`;
    case 'INFO':
      return `<span class="gm-badge" style="background:rgba(59, 130, 246, 0.15); color:#3b82f6; border:1px solid rgba(59, 130, 246, 0.3); font-weight:600; font-size:0.75rem; padding:2px 8px; border-radius:6px;">${escapeHTML(level)}</span>`;
    default:
      return `<span class="gm-badge" style="background:rgba(156, 163, 175, 0.15); color:#9ca3af; border:1px solid rgba(156, 163, 175, 0.3); font-weight:600; font-size:0.75rem; padding:2px 8px; border-radius:6px;">${escapeHTML(level)}</span>`;
  }
}

export class AuditView {
  private static isInitialized = false;

  public static async init(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    const btnRefresh = document.getElementById('btn-refresh-audit-logs');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.loadLogs());
    }

    const searchInput = document.getElementById('filter-logs-search');
    if (searchInput) {
      let debounceTimeout: any = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => this.loadLogs(), 300);
      });
    }

    const levelSelect = document.getElementById('filter-logs-level');
    if (levelSelect) {
      levelSelect.addEventListener('change', () => this.loadLogs());
    }

    const serviceSelect = document.getElementById('filter-logs-service');
    if (serviceSelect) {
      serviceSelect.addEventListener('change', () => this.loadLogs());
    }

    const guildSelect = document.getElementById('filter-logs-guild');
    if (guildSelect) {
      guildSelect.addEventListener('change', () => this.loadLogs());
    }

    this.populateGuildSelect();
    this.startAutoRefresh();
  }

  public static populateGuildSelect(): void {
    const guildSelect = document.getElementById('filter-logs-guild') as HTMLSelectElement | null;
    if (!guildSelect) return;

    const knownGuilds = ['ALPHA', 'OMEGA', 'BABE', 'IMK', 'YARR', 'CLAW', 'DEMO', 'SEN', 'NIGHTWRAITH', 'OBSIDIANSTAR', 'ASTRAL_LIBERION', 'BLACKTHUNDER', 'TWILIGHT'];
    
    // Preserve "ALL" option
    guildSelect.innerHTML = '<option value="ALL">All Guilds</option>';
    for (const g of knownGuilds) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      guildSelect.appendChild(opt);
    }
  }

  public static startAutoRefresh(): void {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
      const chk = document.getElementById('chk-auto-refresh-logs') as HTMLInputElement | null;
      const tab = document.getElementById('tab-system-logs');
      if (chk && chk.checked && tab && tab.classList.contains('active')) {
        this.loadLogs(true);
      }
    }, 10000);
  }

  public static async loadLogs(silent = false): Promise<void> {
    const container = document.getElementById('audit-logs-table-container');
    if (!container) return;

    if (!silent) {
      container.innerHTML = `
        <div class="gm-empty" style="padding:2rem;">
          <i class="ph-duotone ph-arrows-clockwise gm-icon" style="animation: spin 1s linear infinite;"></i>
          <div class="gm-empty-title">Fetching system audit logs...</div>
        </div>`;
    }

    // 1. Fetch Stats
    this.updateStats();

    // 2. Fetch Filter Values
    const searchInput = document.getElementById('filter-logs-search') as HTMLInputElement | null;
    const levelSelect = document.getElementById('filter-logs-level') as HTMLSelectElement | null;
    const serviceSelect = document.getElementById('filter-logs-service') as HTMLSelectElement | null;
    const guildSelect = document.getElementById('filter-logs-guild') as HTMLSelectElement | null;

    const filters = {
      search: searchInput?.value || '',
      level: levelSelect?.value || 'ALL',
      service: serviceSelect?.value || 'ALL',
      guild: guildSelect?.value || 'ALL',
      limit: 50,
    };

    const { logs, count } = await AuditService.getLogs(filters);

    if (!logs || logs.length === 0) {
      container.innerHTML = `
        <div class="gm-empty" style="padding:3rem 1rem;">
          <i class="ph-duotone ph-check-circle gm-icon" style="color:#10b981;"></i>
          <div class="gm-empty-title">No log events recorded matching criteria</div>
          <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">System operates smoothly.</p>
        </div>`;
      return;
    }

    let rowsHtml = '';
    logs.forEach((log, idx) => {
      const timeAgo = formatTimeAgo(log.created_at || '');
      const fullIso = log.created_at || '';
      const badge = getLevelBadge(log.level);
      const service = escapeHTML(log.service || '-');
      const guild = log.guild ? `<span class="gm-badge gm-badge-blue" style="font-size:0.75rem; padding:1px 6px;">${escapeHTML(log.guild)}</span>` : '<span style="color:var(--text-muted); font-size:0.8rem;">global</span>';
      const user = escapeHTML(log.user_identifier || '-');
      const message = escapeHTML(log.message || '');
      const duration = typeof log.duration_ms === 'number' ? `<span style="font-size:0.75rem; color:var(--text-muted);">${log.duration_ms}ms</span>` : '-';
      const hasDetails = (log.metadata && Object.keys(log.metadata).length > 0) || !!log.error_details;

      rowsHtml += `
        <tr style="border-bottom: 1px solid var(--border-color); transition: background 0.15s;" class="audit-log-row" data-index="${idx}">
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap; font-size:0.8rem; color:var(--text-secondary);" title="${fullIso}">
            ${timeAgo}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap;">
            ${badge}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap; font-weight:600; font-size:0.85rem; color:var(--text-primary);">
            ${service}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap;">
            ${guild}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap; font-size:0.8rem; color:var(--text-secondary);">
            ${user}
          </td>
          <td style="padding: 0.65rem 0.75rem; font-size:0.85rem; color:var(--text-primary); max-width:400px; overflow:hidden; text-overflow:ellipsis;">
            ${message}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap; text-align:right;">
            ${duration}
          </td>
          <td style="padding: 0.65rem 0.75rem; text-align:center; white-space:nowrap;">
            ${hasDetails ? `<button class="gm-btn gm-btn-ghost gm-btn-sm btn-inspect-log" data-index="${idx}" title="Inspect Details"><i class="ph ph-brackets-curly"></i></button>` : ''}
          </td>
        </tr>`;
    });

    container.innerHTML = `
      <table class="gm-table" style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom: 2px solid var(--border-color); text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted);">
            <th style="padding:0.5rem 0.75rem;">Time</th>
            <th style="padding:0.5rem 0.75rem;">Level</th>
            <th style="padding:0.5rem 0.75rem;">Service</th>
            <th style="padding:0.5rem 0.75rem;">Guild</th>
            <th style="padding:0.5rem 0.75rem;">User</th>
            <th style="padding:0.5rem 0.75rem;">Message</th>
            <th style="padding:0.5rem 0.75rem; text-align:right;">Latency</th>
            <th style="padding:0.5rem 0.75rem; text-align:center;">Details</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      <div style="margin-top:0.75rem; font-size:0.8rem; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
        <span>Showing ${logs.length} of ${count} events</span>
        <span>Correlation-aware distributed tracing</span>
      </div>`;

    // Attach inspect click handlers
    container.querySelectorAll('.btn-inspect-log').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(btn.getAttribute('data-index') || '0', 10);
        const log = logs[index];
        if (log) this.showDetailModal(log);
      });
    });
  }

  public static async updateStats(): Promise<void> {
    const stats = await AuditService.getStats();
    const statTotal = document.getElementById('stat-total-logs');
    const statErrors = document.getElementById('stat-errors-logs');
    const statWarn = document.getElementById('stat-warn-logs');
    const statLatency = document.getElementById('stat-latency-logs');

    if (statTotal) statTotal.textContent = String(stats.total24h);
    if (statErrors) statErrors.textContent = String(stats.errors24h + stats.fatal24h);
    if (statWarn) statWarn.textContent = String(stats.warn24h);
    if (statLatency) statLatency.textContent = `${stats.avgDurationMs} ms`;
  }

  public static showDetailModal(log: SystemAuditLog): void {
    let modal = document.getElementById('audit-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'audit-detail-modal';
      modal.className = 'gm-modal-backdrop';
      document.body.appendChild(modal);
    }

    const payloadJson = JSON.stringify(log.metadata || {}, null, 2);
    const errorJson = log.error_details ? JSON.stringify(log.error_details, null, 2) : null;

    modal.innerHTML = `
      <div class="gm-modal-card" style="max-width: 680px; max-height: 85vh; display:flex; flex-direction:column;">
        <div class="gm-modal-header">
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <i class="ph ph-terminal-window" style="font-size:1.25rem; color:#3b82f6;"></i>
            <h3 class="gm-modal-title">Log Event Details</h3>
          </div>
          <button class="gm-btn gm-btn-ghost gm-btn-sm" id="btn-close-audit-modal"><i class="ph ph-x"></i></button>
        </div>
        <div class="gm-modal-body" style="overflow-y:auto; flex:1; font-size:0.85rem;">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.75rem; margin-bottom:1rem; background:rgba(255,255,255,0.03); padding:0.75rem; border-radius:8px;">
            <div><strong>Timestamp:</strong> <span style="color:var(--text-muted);">${escapeHTML(log.created_at || '')}</span></div>
            <div><strong>Level:</strong> ${getLevelBadge(log.level)}</div>
            <div><strong>Service:</strong> <span style="color:var(--text-primary); font-weight:600;">${escapeHTML(log.service)}</span></div>
            <div><strong>Duration:</strong> <span style="color:var(--text-muted);">${log.duration_ms != null ? log.duration_ms + ' ms' : '-'}</span></div>
            <div><strong>Correlation ID:</strong> <code style="font-size:0.75rem;">${escapeHTML(log.correlation_id || '-')}</code></div>
            <div><strong>Guild / User:</strong> <span style="color:var(--text-muted);">${escapeHTML(log.guild || 'global')} / ${escapeHTML(log.user_identifier || '-')}</span></div>
          </div>
          
          <div style="margin-bottom:1rem;">
            <div style="font-weight:600; margin-bottom:0.25rem;">Message:</div>
            <div style="background:rgba(0,0,0,0.3); padding:0.65rem; border-radius:6px; font-family:monospace; word-break:break-all;">${escapeHTML(log.message)}</div>
          </div>

          ${errorJson ? `
          <div style="margin-bottom:1rem;">
            <div style="font-weight:600; color:#ef4444; margin-bottom:0.25rem;">Error &amp; Stacktrace:</div>
            <pre style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); color:#fca5a5; padding:0.75rem; border-radius:6px; font-size:0.75rem; overflow-x:auto; max-height:200px;">${escapeHTML(errorJson)}</pre>
          </div>` : ''}

          <div>
            <div style="font-weight:600; margin-bottom:0.25rem;">Sanitized Metadata Payload:</div>
            <pre style="background:rgba(0,0,0,0.4); border:1px solid var(--border-color); padding:0.75rem; border-radius:6px; font-size:0.75rem; overflow-x:auto; max-height:220px;">${escapeHTML(payloadJson)}</pre>
          </div>
        </div>
      </div>`;

    modal.classList.add('active');

    const btnClose = modal.querySelector('#btn-close-audit-modal');
    if (btnClose) {
      btnClose.addEventListener('click', () => modal?.classList.remove('active'));
    }
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal?.classList.remove('active');
    });
  }
}
