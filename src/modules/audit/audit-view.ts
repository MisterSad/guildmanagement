/**
 * src/modules/audit/audit-view.ts
 *
 * Interactive Player Portal Audit Logs & Activity Console for Super Admins.
 * Real-time event stream, multi-criteria filters, summary metrics, and detail inspect modal.
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

function formatExactDate(isoString: string): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  } catch {
    return isoString;
  }
}

function getActionBadge(actionType?: string | null, level: string = 'INFO'): string {
  switch (actionType) {
    case 'score_submission':
      return `<span class="gm-badge" style="background:rgba(16, 185, 129, 0.15); color:#10b981; border:1px solid rgba(16, 185, 129, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-sword"></i> Score Submit</span>`;
    case 'metrics_update':
      return `<span class="gm-badge" style="background:rgba(139, 92, 246, 0.15); color:#8b5cf6; border:1px solid rgba(139, 92, 246, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-lightning"></i> Metrics Update</span>`;
    case 'power_update':
      return `<span class="gm-badge" style="background:rgba(59, 130, 246, 0.15); color:#3b82f6; border:1px solid rgba(59, 130, 246, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-gauge"></i> Power Update</span>`;
    case 'glory_update':
      return `<span class="gm-badge" style="background:rgba(245, 158, 11, 0.15); color:#f59e0b; border:1px solid rgba(245, 158, 11, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-trophy"></i> Glory Score</span>`;
    case 'absence_set':
      return `<span class="gm-badge" style="background:rgba(249, 115, 22, 0.15); color:#f97316; border:1px solid rgba(249, 115, 22, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-calendar-blank"></i> Absence Set</span>`;
    case 'absence_delete':
      return `<span class="gm-badge" style="background:rgba(239, 68, 68, 0.15); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-calendar-x"></i> Absence Cancel</span>`;
    case 'transfer_request':
      return `<span class="gm-badge" style="background:rgba(99, 102, 241, 0.15); color:#6366f1; border:1px solid rgba(99, 102, 241, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-arrows-left-right"></i> Transfer</span>`;
    case 'timezone_update':
      return `<span class="gm-badge" style="background:rgba(20, 184, 166, 0.15); color:#14b8a6; border:1px solid rgba(20, 184, 166, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-globe"></i> Timezone</span>`;
    case 'push_prefs':
      return `<span class="gm-badge" style="background:rgba(100, 116, 139, 0.15); color:#94a3b8; border:1px solid rgba(100, 116, 139, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;"><i class="ph ph-bell"></i> Push Prefs</span>`;
    default:
      if (level === 'ERROR' || level === 'FATAL') {
        return `<span class="gm-badge" style="background:rgba(239, 68, 68, 0.15); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px;">${escapeHTML(level)}</span>`;
      }
      if (level === 'WARN') {
        return `<span class="gm-badge" style="background:rgba(245, 158, 11, 0.15); color:#f59e0b; border:1px solid rgba(245, 158, 11, 0.3); font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px;">${escapeHTML(level)}</span>`;
      }
      return `<span class="gm-badge" style="background:rgba(59, 130, 246, 0.15); color:#3b82f6; border:1px solid rgba(59, 130, 246, 0.3); font-weight:600; font-size:0.75rem; padding:2px 8px; border-radius:6px;">SYSTEM</span>`;
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

    const actionSelect = document.getElementById('filter-logs-action');
    if (actionSelect) {
      actionSelect.addEventListener('change', () => this.loadLogs());
    }

    const levelSelect = document.getElementById('filter-logs-level');
    if (levelSelect) {
      levelSelect.addEventListener('change', () => this.loadLogs());
    }

    const guildSelect = document.getElementById('filter-logs-guild');
    if (guildSelect) {
      guildSelect.addEventListener('change', () => this.loadLogs());
    }

    this.populateGuildSelect();
    this.startAutoRefresh();
    this.loadLogs();
  }

  public static populateGuildSelect(): void {
    const guildSelect = document.getElementById('filter-logs-guild') as HTMLSelectElement | null;
    if (!guildSelect) return;

    const knownGuilds = [
      'ALPHA', 'OMEGA', 'BABE', 'IMK', 'YARR', 'CLAW', 'DEMO',
      'SEN', 'NIGHTWRAITH', 'OBSIDIANSTAR', 'ASTRAL_LIBERION', 'BLACKTHUNDER', 'TWILIGHT'
    ];

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
          <div class="gm-empty-title">Fetching player submission logs...</div>
        </div>`;
    }

    // 1. Fetch Stats
    this.updateStats();

    // 2. Fetch Filter Values
    const searchInput = document.getElementById('filter-logs-search') as HTMLInputElement | null;
    const actionSelect = document.getElementById('filter-logs-action') as HTMLSelectElement | null;
    const levelSelect = document.getElementById('filter-logs-level') as HTMLSelectElement | null;
    const guildSelect = document.getElementById('filter-logs-guild') as HTMLSelectElement | null;

    const filters = {
      search: searchInput?.value || '',
      action_type: actionSelect?.value || 'ALL',
      level: levelSelect?.value || 'ALL',
      guild: guildSelect?.value || 'ALL',
      limit: 100,
    };

    const { logs, count } = await AuditService.getLogs(filters);

    if (!logs || logs.length === 0) {
      container.innerHTML = `
        <div class="gm-empty" style="padding:3rem 1rem;">
          <i class="ph-duotone ph-check-circle gm-icon" style="color:#10b981;"></i>
          <div class="gm-empty-title">No audit logs matching current filter criteria</div>
          <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">Player submissions and modifications will appear here in real-time.</p>
        </div>`;
      return;
    }

    let rowsHtml = '';
    logs.forEach((log, idx) => {
      const timeAgo = formatTimeAgo(log.created_at || '');
      const exactTime = formatExactDate(log.created_at || '');
      const actionBadge = getActionBadge(log.action_type, log.level);
      
      const pseudo = log.pseudo || log.user_identifier?.split(' ')?.[0] || 'System';
      const uid = log.uid || (log.user_identifier?.includes('(') ? log.user_identifier.split('(')[1]?.replace(')', '') : '-');
      const server = log.server_number ? `#${escapeHTML(log.server_number)}` : '-';
      const guild = log.guild ? `<span class="gm-badge gm-badge-blue" style="font-size:0.75rem; padding:1px 6px;">${escapeHTML(log.guild)}</span>` : '<span style="color:var(--text-muted); font-size:0.8rem;">global</span>';
      
      const message = escapeHTML(log.message || '');
      const hasDetails = (log.metadata && Object.keys(log.metadata).length > 0) || !!log.error_details;

      rowsHtml += `
        <tr style="border-bottom: 1px solid var(--border-color); transition: background 0.15s;" class="audit-log-row" data-index="${idx}">
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap; font-size:0.8rem; color:var(--text-secondary);" title="${exactTime}">
            <div style="font-weight:600; color:var(--text-primary); font-size:0.75rem;">${exactTime}</div>
            <div style="font-size:0.7rem; color:var(--text-muted);">${timeAgo}</div>
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap;">
            <div style="display:flex; align-items:center; gap:0.35rem;">
              <i class="ph ph-user-circle" style="color:var(--accent-primary); font-size:1.1rem;"></i>
              <span style="font-weight:700; color:var(--text-primary); font-size:0.85rem;">${escapeHTML(pseudo)}</span>
            </div>
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap;">
            <code style="font-size:0.75rem; background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; border:1px solid var(--border-color);">${escapeHTML(uid)}</code>
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap; font-size:0.8rem; color:var(--text-secondary); font-weight:600;">
            ${server}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap;">
            ${guild}
          </td>
          <td style="padding: 0.65rem 0.75rem; white-space:nowrap;">
            ${actionBadge}
          </td>
          <td style="padding: 0.65rem 0.75rem; font-size:0.85rem; color:var(--text-primary); max-width:420px; word-break:break-word;">
            ${message}
          </td>
          <td style="padding: 0.65rem 0.75rem; text-align:center; white-space:nowrap;">
            ${hasDetails ? `<button class="gm-btn gm-btn-ghost gm-btn-sm btn-inspect-log" data-index="${idx}" title="Inspect Details & Diffs"><i class="ph ph-eye"></i></button>` : ''}
          </td>
        </tr>`;
    });

    container.innerHTML = `
      <table class="gm-table" style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom: 2px solid var(--border-color); text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted);">
            <th style="padding:0.5rem 0.75rem;">Date &amp; Time (UTC)</th>
            <th style="padding:0.5rem 0.75rem;">Player</th>
            <th style="padding:0.5rem 0.75rem;">UID</th>
            <th style="padding:0.5rem 0.75rem;">Server</th>
            <th style="padding:0.5rem 0.75rem;">Guild</th>
            <th style="padding:0.5rem 0.75rem;">Action</th>
            <th style="padding:0.5rem 0.75rem;">Modification / Summary</th>
            <th style="padding:0.5rem 0.75rem; text-align:center;">Inspect</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      <div style="margin-top:0.75rem; font-size:0.8rem; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
        <span>Showing ${logs.length} of ${count} logged submissions</span>
        <span>Real-time Player Portal Audit Stream</span>
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
    const statScores = document.getElementById('stat-scores-logs');
    const statMetrics = document.getElementById('stat-metrics-logs');
    const statPlayers = document.getElementById('stat-players-logs');

    if (statTotal) statTotal.textContent = String(stats.total24h);
    if (statScores) statScores.textContent = String(stats.scores24h);
    if (statMetrics) statMetrics.textContent = String(stats.metrics24h);
    if (statPlayers) statPlayers.textContent = String(stats.uniquePlayers24h);
  }

  public static showDetailModal(log: SystemAuditLog): void {
    let modal = document.getElementById('audit-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'audit-detail-modal';
      modal.className = 'gm-modal-backdrop';
      document.body.appendChild(modal);
    }

    const pseudo = log.pseudo || log.user_identifier?.split(' ')?.[0] || 'System';
    const uid = log.uid || (log.user_identifier?.includes('(') ? log.user_identifier.split('(')[1]?.replace(')', '') : '-');
    const server = log.server_number ? `#${escapeHTML(log.server_number)}` : '-';
    const actionBadge = getActionBadge(log.action_type, log.level);
    const payloadJson = JSON.stringify(log.metadata || {}, null, 2);
    const errorJson = log.error_details ? JSON.stringify(log.error_details, null, 2) : null;

    modal.innerHTML = `
      <div class="gm-modal-card" style="max-width: 720px; max-height: 85vh; display:flex; flex-direction:column;">
        <div class="gm-modal-header">
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <i class="ph ph-clipboard-text" style="font-size:1.25rem; color:var(--accent-primary);"></i>
            <h3 class="gm-modal-title">Player Submission Audit Record</h3>
          </div>
          <button class="gm-btn gm-btn-ghost gm-btn-sm" id="btn-close-audit-modal"><i class="ph ph-x"></i></button>
        </div>
        <div class="gm-modal-body" style="overflow-y:auto; flex:1; font-size:0.85rem;">
          <!-- Player Info Grid -->
          <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:0.75rem; margin-bottom:1rem; background:rgba(255,255,255,0.03); padding:0.85rem; border-radius:8px; border:1px solid var(--border-color);">
            <div><strong>Player:</strong> <span style="color:var(--text-primary); font-weight:700;">${escapeHTML(pseudo)}</span></div>
            <div><strong>UID:</strong> <code style="font-size:0.8rem;">${escapeHTML(uid)}</code></div>
            <div><strong>Guild:</strong> <span class="gm-badge gm-badge-blue" style="font-size:0.75rem; padding:1px 6px;">${escapeHTML(log.guild || 'global')}</span></div>
            <div><strong>Server:</strong> <span style="font-weight:600; color:var(--text-primary);">${server}</span></div>
            <div><strong>Action:</strong> ${actionBadge}</div>
            <div><strong>Date/Time:</strong> <span style="color:var(--text-muted); font-size:0.75rem;">${formatExactDate(log.created_at || '')}</span></div>
          </div>
          
          <!-- Modification Message -->
          <div style="margin-bottom:1rem;">
            <div style="font-weight:600; margin-bottom:0.35rem; color:var(--text-secondary); text-transform:uppercase; font-size:0.75rem;">Modification Summary:</div>
            <div style="background:rgba(0,0,0,0.3); padding:0.75rem; border-radius:6px; font-weight:500; border:1px solid var(--border-color); color:var(--text-primary);">${escapeHTML(log.message)}</div>
          </div>

          ${errorJson ? `
          <div style="margin-bottom:1rem;">
            <div style="font-weight:600; color:#ef4444; margin-bottom:0.25rem;">Error &amp; Stacktrace:</div>
            <pre style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); color:#fca5a5; padding:0.75rem; border-radius:6px; font-size:0.75rem; overflow-x:auto; max-height:180px;">${escapeHTML(errorJson)}</pre>
          </div>` : ''}

          <!-- Structured Payload -->
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.35rem;">
              <span style="font-weight:600; color:var(--text-secondary); text-transform:uppercase; font-size:0.75rem;">Structured Audit Payload (JSON):</span>
              <button class="gm-btn gm-btn-secondary gm-btn-sm" id="btn-copy-audit-json" style="font-size:0.75rem; padding:2px 8px;">
                <i class="ph ph-copy"></i> Copy JSON
              </button>
            </div>
            <pre id="audit-json-content" style="background:rgba(0,0,0,0.4); border:1px solid var(--border-color); padding:0.75rem; border-radius:6px; font-size:0.75rem; overflow-x:auto; max-height:240px; color:#a5b4fc;">${escapeHTML(payloadJson)}</pre>
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

    const btnCopy = modal.querySelector('#btn-copy-audit-json');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(payloadJson);
        btnCopy.innerHTML = '<i class="ph ph-check"></i> Copied!';
        setTimeout(() => {
          btnCopy.innerHTML = '<i class="ph ph-copy"></i> Copy JSON';
        }, 1500);
      });
    }
  }
}
