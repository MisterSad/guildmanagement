/**
 * sanctions.js — Tracking et historique des sanctions des membres.
 * Alerte récidiviste à partir de 3 sanctions cumulées.
 */
(function () {

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t   = window.GM ? window.GM.t  : function (k) { return k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };

    window.GM_SANCTIONS = { load: loadSanctions };

    var sanctions = [];

    async function loadSanctions() {
        var db = getDb();
        if (!db) return;

        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

        var membersQ = db.from('guild_members').select('pseudo').eq('guild', currentG).order('pseudo', { ascending: true });
        var sanctionsQ = db.from('sanctions').select('*').eq('guild', currentG).order('created_at', { ascending: false });

        var [membersRes, res] = await Promise.all([membersQ, sanctionsQ]);

        var datalist = document.getElementById('member-list-datalist');
        if (datalist && membersRes.data) {
            datalist.innerHTML = membersRes.data.map(function (m) {
                return '<option value="' + esc(m.pseudo) + '">';
            }).join('');
        }

        sanctions = res.data || [];
        renderSanctions();
    }

    function renderSanctions() {
        var list = document.getElementById('sanctions-list');
        var count = document.getElementById('sanctions-count');
        if (!list) return;

        if (count) count.textContent = sanctions.length;

        if (sanctions.length === 0) {
            list.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_sanctions') + '</div></div>';
            return;
        }

        var html = '<div class="gm-sanction-list">';
        var locale = 'en-GB';

        sanctions.forEach(function (s) {
            var dateStr = new Date(s.created_at).toLocaleDateString(locale, {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            var author = s.created_by || '-';
            var initial = window.GM.avatarInit(s.pseudo);
            html +=
                '<div class="gm-sanction-row">' +
                    '<div class="gm-row" style="gap:.5rem;">' +
                        '<div class="gm-avatar">' + esc(initial) + '</div>' +
                        '<strong>' + esc(s.pseudo) + '</strong>' +
                    '</div>' +
                    '<div class="gm-sanction-comment">"' + esc(s.comment) + '"</div>' +
                    '<div class="gm-sanction-meta">' +
                        t('sanction_by') + ' <strong style="color: var(--accent);">' + esc(author) + '</strong> · ' + dateStr +
                    '</div>' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm sanction-delete-btn" data-id="' + s.id + '" title="' + t('delete_title') + '" style="color: var(--danger);">' +
                        '<i class="ph ph-trash"></i>' +
                    '</button>' +
                '</div>';
        });
        html += '</div>';
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
                }
            });
        });
    }

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
                var db = getDb();
                if (!db) return;
                var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
                var res = await db.from('sanctions').insert([{
                    guild: currentG,
                    pseudo: pseudo,
                    comment: comment
                }]).select();

                if (res.error) throw res.error;

                pseudoInput.value = '';
                commentInput.value = '';

                window.GM.showToast(t('toast_sanction_added'), 'success');

                await loadSanctions();
                checkRecidivist(pseudo);

            } catch (err) {
                window.GM.showToast(err.message, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    }

    function checkRecidivist(pseudo) {
        var count = sanctions.filter(function (s) { return s.pseudo === pseudo; }).length;
        if (count >= 3) {
            setTimeout(function () {
                if (window.showConfirm) {
                    window.showConfirm(
                        t('alert_recidivist'),
                        '<strong>' + esc(pseudo) + '</strong> : ' + count + ' ' + t('nav_sanctions'),
                        function () {}
                    );
                }
            }, 500);
        }
    }

    async function deleteSanction(id) {
        var db = getDb();
        if (!db) return;
        try {
            var res = await db.from('sanctions').delete().eq('id', id);
            if (res.error) throw res.error;
            await loadSanctions();
            window.GM.showToast(t('toast_sanction_deleted'), 'success');
        } catch (err) {
            window.GM.showToast(err.message, 'error');
        }
    }
    window.addEventListener('rad-lang-change', function () {
        var activeTab = document.querySelector('.nav-tab.active');
        if (activeTab && activeTab.getAttribute('data-tab') === 'tab-sanctions') {
            renderSanctions();
        }
    });

})();
