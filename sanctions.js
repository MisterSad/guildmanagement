/**
 * sanctions.js — Tracking et historique des sanctions des membres.
 * Alerte récidiviste à partir de 3 sanctions cumulées.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    window.RAD_SANCTIONS = { load: loadSanctions };

    var sanctions = [];

    async function loadSanctions() {
        if (!db) return;

        var membersRes = await db.from('guild_members').select('pseudo').order('pseudo', { ascending: true });
        var datalist = document.getElementById('member-list-datalist');
        if (datalist && membersRes.data) {
            datalist.innerHTML = membersRes.data.map(function (m) {
                return '<option value="' + esc(m.pseudo) + '">';
            }).join('');
        }

        var res = await db.from('sanctions').select('*').order('created_at', { ascending: false });
        sanctions = res.data || [];
        renderSanctions();
    }

    function renderSanctions() {
        var list = document.getElementById('sanctions-list');
        var count = document.getElementById('sanctions-count');
        if (!list) return;

        if (count) count.textContent = sanctions.length;

        if (sanctions.length === 0) {
            list.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            return;
        }

        var html = '<div class="gm-sanction-list">';
        sanctions.forEach(function (s) {
            var dateStr = new Date(s.created_at).toLocaleDateString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            var author = s.created_by || '—';
            var initial = window.RAD.avatarInit(s.pseudo);
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
                var res = await db.from('sanctions').insert([{
                    pseudo: pseudo,
                    comment: comment,
                    created_by: sessionStorage.getItem('rad_user') || 'Admin'
                }]).select();

                if (res.error) throw res.error;

                pseudoInput.value = '';
                commentInput.value = '';

                window.RAD.showToast(t('toast_sanction_added'), 'success');

                await loadSanctions();
                checkRecidivist(pseudo);

            } catch (err) {
                window.RAD.showToast(err.message, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    }

    function checkRecidivist(pseudo) {
        var count = sanctions.filter(function (s) { return s.pseudo === pseudo; }).length;
        if (count >= 3) {
            setTimeout(function () {
                alert(t('alert_recidivist') + '\n(' + pseudo + ' : ' + count + ' sanctions)');
            }, 500);
        }
    }

    async function deleteSanction(id) {
        try {
            var res = await db.from('sanctions').delete().eq('id', id);
            if (res.error) throw res.error;
            await loadSanctions();
            window.RAD.showToast(t('toast_account_deleted'), 'success');
        } catch (err) {
            window.RAD.showToast(err.message, 'error');
        }
    }

})();
