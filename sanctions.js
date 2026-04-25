/**
 * sanctions.js — Tracking and history of member sanctions.
 * Triggers an alert if a player reaches 3 or more sanctions.
 */
(function () {

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';
    var db;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { console.error('sanctions.js init', e); }

    function t(k) { return window.RAD_I18N ? window.RAD_I18N.t(k) : k; }
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;'); }

    window.RAD_SANCTIONS = { load: loadSanctions };

    var sanctions = [];

    // ── Load sanctions history ────────────────────────────────────────────────
    async function loadSanctions() {
        if (!db) return;
        
        // Load guild members to populate datalist
        var membersRes = await db.from('guild_members').select('pseudo').order('pseudo', { ascending: true });
        var datalist = document.getElementById('member-list-datalist');
        if (datalist && membersRes.data) {
            datalist.innerHTML = membersRes.data.map(function(m) { return '<option value="' + esc(m.pseudo) + '">'; }).join('');
        }

        var res = await db.from('sanctions').select('*').order('created_at', { ascending: false });
        sanctions = res.data || [];
        renderSanctions();
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function renderSanctions() {
        var list = document.getElementById('sanctions-list');
        var count = document.getElementById('sanctions-count');
        if (!list) return;

        if (count) count.textContent = sanctions.length;

        if (sanctions.length === 0) {
            list.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-ghost"></i><p>' + t('empty_members') + '</p></div>';
            return;
        }

        var html = '';
        sanctions.forEach(function (s, i) {
            var dateStr = new Date(s.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            html +=
                '<div class="account-item member-tile slide-up" style="animation-delay:' + (i * 0.03) + 's">' +
                    '<div class="account-info">' +
                        '<span class="account-name"><i class="ph-fill ph-user-focus text-error"></i> ' + esc(s.pseudo) + '</span>' +
                        '<span class="account-pass" style="text-align:left; font-family:inherit; background:rgba(239,68,68,0.05); color:var(--text-main);">' +
                            '<i class="ph ph-chat-text"></i> ' + esc(s.comment) +
                        '</span>' +
                        '<span style="font-size:0.75rem; color:var(--text-muted); display:flex; align-items:center; gap:0.4rem;">' +
                            '<i class="ph ph-calendar"></i> ' + dateStr +
                        '</span>' +
                    '</div>' +
                    '<div class="account-actions">' +
                        '<button class="delete-btn sanction-delete-btn" data-id="' + s.id + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button>' +
                    '</div>' +
                '</div>';
        });
        list.innerHTML = html;

        list.querySelectorAll('.sanction-delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-id');
                if (window.showConfirm) {
                    window.showConfirm(
                        t('confirm_delete_sanction_title'),
                        t('confirm_delete_sanction_body'),
                        function () { deleteSanction(id); }
                    );
                } else if (confirm(t('confirm_delete_sanction_body'))) {
                    deleteSanction(id);
                }
            });
        });
    }

    // ── Apply new sanction ────────────────────────────────────────────────────
    var form = document.getElementById('apply-sanction-form');
    if (form) {
        form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var pseudoInput = document.getElementById('sanction-player');
            var commentInput = document.getElementById('sanction-comment');
            var pseudo = pseudoInput.value.trim();
            var comment = commentInput.value.trim();

            if (!pseudo || !comment) return;

            var btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;

            try {
                var res = await db.from('sanctions').insert([{
                    pseudo: pseudo,
                    comment: comment,
                    created_by: sessionStorage.getItem('rad_user') || 'Admin'
                }]).select();

                if (res.error) throw res.error;

                pseudoInput.value = '';
                commentInput.value = '';
                
                if (window.RAD_APP && window.RAD_APP.showToast) {
                    window.RAD_APP.showToast(t('toast_sanction_added'), 'success');
                }

                await loadSanctions();
                checkRecidivist(pseudo);

            } catch (err) {
                alert(err.message);
            } finally {
                btn.disabled = false;
            }
        });
    }

    // ── Check recidivist (>= 3 sanctions) ─────────────────────────────────────
    function checkRecidivist(pseudo) {
        var count = sanctions.filter(function(s) { return s.pseudo === pseudo; }).length;
        if (count >= 3) {
            // Using a simple alert as requested, but could be a custom modal
            setTimeout(function() {
                alert(t('alert_recidivist') + '\n(' + pseudo + ' : ' + count + ' sanctions)');
            }, 500);
        }
    }

    async function deleteSanction(id) {
        try {
            var res = await db.from('sanctions').delete().eq('id', id);
            if (res.error) throw res.error;
            await loadSanctions();
            if (window.RAD_APP && window.RAD_APP.showToast) {
                window.RAD_APP.showToast(t('toast_account_deleted'), 'success');
            }
        } catch (err) {
            if (window.RAD_APP && window.RAD_APP.showToast) {
                window.RAD_APP.showToast(err.message, 'error');
            } else {
                alert(err.message);
            }
        }
    }

})();
