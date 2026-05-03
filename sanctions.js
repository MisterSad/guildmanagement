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
            list.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-ghost"></i><p>' + t('empty_members') + '</p></div>';
            return;
        }

        var html = '';
        sanctions.forEach(function (s, i) {
            var dateStr = new Date(s.created_at).toLocaleDateString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            var author = s.created_by || '—';
            html +=
                '<div class="list-row sanction-row" style="animation-delay:' + (i * 0.02) + 's">' +
                    '<span class="list-pseudo"><i class="ph-fill ph-user-focus text-error"></i> ' + esc(s.pseudo) + '</span>' +
                    '<div class="list-meta">' +
                        '<span class="list-meta-item sanction-comment"><i class="ph ph-chat-text"></i> ' + esc(s.comment) + '</span>' +
                        '<span class="list-meta-item"><i class="ph ph-calendar"></i> ' + dateStr + '</span>' +
                        '<span class="list-meta-item"><i class="ph ph-gavel"></i> ' + t('sanction_by') + ' <span class="sanction-author">' + esc(author) + '</span></span>' +
                    '</div>' +
                    '<div class="list-actions">' +
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
