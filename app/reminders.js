/**
 * reminders.js: per-guild reminder schedule editor (saas_strategy.md §10).
 *
 * R5-only CRUD over the guild_event_schedules table consumed by the
 * event-reminders edge function (v2). That table ships with the multi-tenant
 * migration, so on the current production schema it does not exist yet: this
 * module DETECTS its absence and renders an informational notice instead of
 * erroring. Once the cutover lands, the same UI drives the live schedule.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    var KINDS = ['gvg_war_prism', 'gvg_war_fortress', 'svs_garrison', 'svs_battle', 'calamity_round', 'custom'];
    // day_utc 0-6 (0 = Sunday), displayed Monday-first.
    var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
    var DAY_KEYS  = { 0: 'day_sun', 1: 'day_mon', 2: 'day_tue', 3: 'day_wed', 4: 'day_thu', 5: 'day_fri', 6: 'day_sat' };

    var schedules = [];

    window.RAD_REMINDERS = { load: load };

    function area() { return document.getElementById('reminders-area'); }

    function pad2(n) { return String(n).padStart(2, '0'); }
    function timeStr(v) { return (v || '00:00:00').slice(0, 5); }
    function dayName(d) { return t(DAY_KEYS[d] || 'day_mon'); }
    function kindLabel(k) { return t('rem_kind_' + k) || k; }
    function offsetsText(arr) { return Array.isArray(arr) ? arr.join(', ') : String(arr || ''); }

    function parseOffsets(str) {
        return String(str || '')
            .split(',')
            .map(function (s) { return parseInt(s.trim(), 10); })
            .filter(function (n) { return !isNaN(n) && n >= 0 && n <= 1440; });
    }

    async function load() {
        var el = area();
        if (!el || !db) return;
        el.innerHTML = '<div class="gm-dim" style="padding:.5rem 0;"><i class="ph ph-spinner ph-spin"></i> …</div>';

        var res = await db.from('guild_event_schedules').select('*').order('day_utc').order('time_utc');
        if (res.error) {
            // Table not migrated yet (pre-cutover). PostgREST answers a missing
            // table from its schema cache with PGRST205 ("Could not find the
            // table …"); Postgres' own undefined_table is 42P01. Cover both.
            var code = res.error.code || '';
            var msg = res.error.message || '';
            var notReady = code === 'PGRST205' || code === '42P01' ||
                /could not find the table|does not exist|schema cache/i.test(msg);
            el.innerHTML = '<div class="gm-empty">' +
                '<i class="ph-duotone ph-' + (notReady ? 'rocket-launch' : 'warning') + ' gm-icon"></i>' +
                '<div class="gm-empty-title">' + esc(notReady ? t('reminders_not_ready') : t('toast_err_generic')) + '</div>' +
                (notReady ? '<div class="gm-empty-hint">' + esc(t('reminders_not_ready_hint')) + '</div>' : '') +
                '</div>';
            return;
        }
        schedules = res.data || [];
        render();
    }

    function render() {
        var el = area();
        if (!el) return;

        var rows = schedules.slice().sort(function (a, b) {
            var da = DAY_ORDER.indexOf(a.day_utc), dbb = DAY_ORDER.indexOf(b.day_utc);
            if (da !== dbb) return da - dbb;
            return timeStr(a.time_utc).localeCompare(timeStr(b.time_utc));
        });

        var html = '<div class="gm-row" style="justify-content:flex-end; gap:.5rem; margin-bottom:.75rem;">';
        if (rows.length === 0) {
            html += '<button class="gm-btn gm-btn-ghost gm-btn-sm" data-rem-template><i class="ph ph-stack"></i> <span>' + t('reminders_load_template') + '</span></button>';
        }
        html += '<button class="gm-btn gm-btn-primary gm-btn-sm" data-rem-add><i class="ph ph-plus"></i> <span>' + t('reminders_add') + '</span></button></div>';

        if (rows.length === 0) {
            html += '<div class="gm-empty"><i class="ph-duotone ph-bell-slash gm-icon"></i><div class="gm-empty-title">' + t('reminders_empty') + '</div></div>';
        } else {
            html += '<div class="gm-member-list">';
            rows.forEach(function (s) {
                html += '<div class="gm-member-row"' + (s.enabled ? '' : ' style="opacity:.5;"') + '>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-member-pseudo gm-truncate">' + esc(s.label || kindLabel(s.kind)) +
                            ' <span class="gm-chip gm-chip-info" style="font-size:.7rem;">' + esc(kindLabel(s.kind)) + '</span>' +
                            (s.requires_event ? ' <span class="gm-chip" style="font-size:.7rem;">' + esc(t('reminders_requires')) + ' ' + esc(s.requires_event) + '</span>' : '') +
                            (s.enabled ? '' : ' <span class="gm-chip" style="font-size:.7rem;">' + esc(t('reminders_disabled')) + '</span>') +
                        '</div>' +
                        '<div class="gm-dim gm-mono" style="font-size:.78rem; margin-top:2px;">' +
                            esc(dayName(s.day_utc)) + ' · ' + esc(timeStr(s.time_utc)) + ' UTC · ' +
                            esc(t('reminders_offsets')) + ': ' + esc(offsetsText(s.reminder_offsets)) +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-member-actions">' +
                        '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm rem-edit" data-id="' + esc(s.id) + '" title="' + t('edit_title') + '"><i class="ph ph-pencil-simple"></i></button>' +
                        '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm rem-del" data-id="' + esc(s.id) + '" title="' + t('delete_title') + '" style="color:var(--danger);"><i class="ph ph-trash"></i></button>' +
                    '</div>' +
                '</div>';
            });
            html += '</div>';
        }
        el.innerHTML = html;

        var addBtn = el.querySelector('[data-rem-add]');
        if (addBtn) addBtn.addEventListener('click', function () { openDialog(null); });
        var tplBtn = el.querySelector('[data-rem-template]');
        if (tplBtn) tplBtn.addEventListener('click', loadTemplate);
        el.querySelectorAll('.rem-edit').forEach(function (b) {
            b.addEventListener('click', function () {
                var s = schedules.find(function (x) { return String(x.id) === b.getAttribute('data-id'); });
                if (s) openDialog(s);
            });
        });
        el.querySelectorAll('.rem-del').forEach(function (b) {
            b.addEventListener('click', function () {
                var id = b.getAttribute('data-id');
                window.showConfirm(t('reminders_delete_title'), t('reminders_delete_body'), function () { remove(id); });
            });
        });
    }

    function openDialog(existing) {
        var prev = document.getElementById('rem-overlay');
        if (prev) prev.remove();

        var s = existing || { kind: 'custom', label: '', day_utc: 6, time_utc: '14:00:00', reminder_offsets: [5, 0], requires_event: '', enabled: true };

        var kindOpts = KINDS.map(function (k) {
            return '<option value="' + k + '"' + (k === s.kind ? ' selected' : '') + '>' + esc(kindLabel(k)) + '</option>';
        }).join('');
        var dayOpts = DAY_ORDER.map(function (d) {
            return '<option value="' + d + '"' + (d === s.day_utc ? ' selected' : '') + '>' + esc(dayName(d)) + '</option>';
        }).join('');

        var overlay = document.createElement('div');
        overlay.id = 'rem-overlay';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card" style="max-width:520px;">' +
                '<div class="confirm-icon"><i class="ph-fill ph-bell-ringing text-accent"></i></div>' +
                '<h3>' + esc(existing ? t('reminders_edit_title') : t('reminders_add')) + '</h3>' +
                '<form id="rem-form" class="gm-col" style="gap:.85rem; text-align:left; margin-top:1rem;">' +
                    '<div class="gm-row" style="gap:.75rem; flex-wrap:wrap;">' +
                        '<div class="gm-col" style="flex:1; min-width:180px; gap:.3rem;"><label class="gm-dim" style="font-size:.8rem;">' + t('reminders_kind') + '</label><select id="rem-kind" class="gm-input">' + kindOpts + '</select></div>' +
                        '<div class="gm-col" style="flex:1; min-width:160px; gap:.3rem;"><label class="gm-dim" style="font-size:.8rem;">' + t('reminders_label') + '</label><input id="rem-label" class="gm-input" maxlength="60" value="' + esc(s.label || '') + '"></div>' +
                    '</div>' +
                    '<div class="gm-row" style="gap:.75rem; flex-wrap:wrap;">' +
                        '<div class="gm-col" style="flex:1; min-width:150px; gap:.3rem;"><label class="gm-dim" style="font-size:.8rem;">' + t('reminders_day') + '</label><select id="rem-day" class="gm-input">' + dayOpts + '</select></div>' +
                        '<div class="gm-col" style="flex:1; min-width:120px; gap:.3rem;"><label class="gm-dim" style="font-size:.8rem;">' + t('reminders_time') + '</label><input type="time" id="rem-time" class="gm-input" value="' + esc(timeStr(s.time_utc)) + '"></div>' +
                    '</div>' +
                    '<div class="gm-col" style="gap:.3rem;"><label class="gm-dim" style="font-size:.8rem;">' + t('reminders_offsets_label') + '</label><input id="rem-offsets" class="gm-input" placeholder="30, 15, 5, 0" value="' + esc(offsetsText(s.reminder_offsets)) + '"></div>' +
                    '<div class="gm-col" style="gap:.3rem;"><label class="gm-dim" style="font-size:.8rem;">' + t('reminders_requires_label') + '</label><input id="rem-requires" class="gm-input" placeholder="SvS / GvG…" value="' + esc(s.requires_event || '') + '"></div>' +
                    '<label class="gm-row" style="gap:.5rem; align-items:center; font-size:.85rem;"><input type="checkbox" id="rem-enabled"' + (s.enabled ? ' checked' : '') + '> ' + t('reminders_enabled') + '</label>' +
                    '<div class="confirm-actions"><button type="button" id="rem-cancel" class="btn-ghost">' + t('confirm_cancel') + '</button><button type="submit" class="primary-btn">' + t('confirm_ok') + '</button></div>' +
                '</form>' +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function close() { overlay.classList.remove('visible'); setTimeout(function () { overlay.remove(); }, 300); }
        overlay.querySelector('#rem-cancel').addEventListener('click', close);
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
        overlay.querySelector('#rem-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var offsets = parseOffsets(overlay.querySelector('#rem-offsets').value);
            if (offsets.length === 0) { window.RAD.showToast(t('reminders_err_offsets'), 'error'); return; }
            var rec = {
                kind: overlay.querySelector('#rem-kind').value,
                label: overlay.querySelector('#rem-label').value.trim() || null,
                day_utc: parseInt(overlay.querySelector('#rem-day').value, 10),
                time_utc: overlay.querySelector('#rem-time').value + ':00',
                reminder_offsets: offsets,
                requires_event: overlay.querySelector('#rem-requires').value.trim() || null,
                enabled: overlay.querySelector('#rem-enabled').checked
            };
            var okSave = await save(existing ? existing.id : null, rec);
            if (okSave) close();
        });
    }

    async function save(id, rec) {
        try {
            var res = id
                ? await db.from('guild_event_schedules').update(rec).eq('id', id)
                : await db.from('guild_event_schedules').insert([rec]);
            if (res.error) throw res.error;
            window.RAD.showToast(t('toast_config_updated'), 'success');
            await load();
            return true;
        } catch (err) {
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            return false;
        }
    }

    async function remove(id) {
        try {
            var res = await db.from('guild_event_schedules').delete().eq('id', id);
            if (res.error) throw res.error;
            window.RAD.showToast(t('toast_account_deleted'), 'success');
            await load();
        } catch (err) {
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // Default schedule template (mirrors the multi-tenant migration seed for the
    // game's standard server times). Only offered when the guild has no slots.
    function templateRows() {
        var rows = [];
        var gvg = [
            ['gvg_war_prism', 'War Prism', 6, '00:00'], ['gvg_war_prism', 'War Prism', 6, '01:00'],
            ['gvg_war_fortress', 'War Fortress', 6, '10:00'], ['gvg_war_prism', 'War Prism', 6, '13:00'],
            ['gvg_war_prism', 'War Prism', 6, '14:00'], ['gvg_war_fortress', 'War Fortress', 6, '22:00']
        ];
        gvg.forEach(function (r) { rows.push({ kind: r[0], label: r[1], day_utc: r[2], time_utc: r[3] + ':00', reminder_offsets: [5, 0], requires_event: 'GvG', enabled: true }); });
        [['20:00'], ['21:00'], ['22:00'], ['23:00']].forEach(function (r) {
            rows.push({ kind: 'svs_garrison', label: 'Garrison', day_utc: 5, time_utc: r[0] + ':00', reminder_offsets: [0], requires_event: 'SvS', enabled: true });
        });
        rows.push({ kind: 'svs_battle', label: 'Battle', day_utc: 6, time_utc: '14:00:00', reminder_offsets: [30, 15, 5, 0], requires_event: 'SvS', enabled: true });
        for (var i = 1; i <= 16; i++) {
            var hour = ((i - 1) % 8) * 3;
            rows.push({ kind: 'calamity_round', label: 'Round ' + i, day_utc: i <= 8 ? 2 : 3, time_utc: pad2(hour) + ':00:00', reminder_offsets: [5], requires_event: null, enabled: true });
        }
        return rows;
    }

    async function loadTemplate() {
        try {
            var res = await db.from('guild_event_schedules').insert(templateRows());
            if (res.error) throw res.error;
            window.RAD.showToast(t('reminders_template_loaded'), 'success');
            await load();
        } catch (err) {
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

})();
