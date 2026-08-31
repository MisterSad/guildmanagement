// gm-webauthn.js — hand-rolled WebAuthn client marshalling.
//
// No @simplewebauthn/browser dependency: this app already pins its 2
// existing CDN scripts by SRI and is actively trying to reduce third-party
// CDN surface, not add to it. The actual cryptographic verification lives
// server-side in the audited @simplewebauthn/server library
// (supabase/functions/auth-passkey); this file only converts between the
// browser's ArrayBuffer-based WebAuthn API and the base64url JSON shapes
// that library expects — see @simplewebauthn/types' RegistrationResponseJSON
// / PublicKeyCredentialCreationOptionsJSON for the exact contract.
(function () {
    'use strict';

    function base64UrlToBuffer(base64url) {
        var padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
        var padLen = (4 - (padded.length % 4)) % 4;
        padded += '='.repeat(padLen);
        var bin = atob(padded);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function bufferToBase64Url(buffer) {
        var bytes = new Uint8Array(buffer);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function isSupported() {
        return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
    }

    // Converts the server's PublicKeyCredentialCreationOptionsJSON into what
    // navigator.credentials.create() actually expects (ArrayBuffers, not
    // base64url strings).
    function registrationOptionsFromServer(options) {
        var publicKey = Object.assign({}, options);
        publicKey.challenge = base64UrlToBuffer(options.challenge);
        publicKey.user = Object.assign({}, options.user, { id: base64UrlToBuffer(options.user.id) });
        if (Array.isArray(options.excludeCredentials)) {
            publicKey.excludeCredentials = options.excludeCredentials.map(function (c) {
                return Object.assign({}, c, { id: base64UrlToBuffer(c.id) });
            });
        }
        return publicKey;
    }

    // Converts the browser's PublicKeyCredential (from create()) into the
    // RegistrationResponseJSON shape the server's verifyRegistrationResponse()
    // expects.
    function registrationCredentialToJSON(credential) {
        var response = credential.response;
        return {
            id: credential.id,
            rawId: bufferToBase64Url(credential.rawId),
            response: {
                clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                attestationObject: bufferToBase64Url(response.attestationObject),
                transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined
            },
            clientExtensionResults: typeof credential.getClientExtensionResults === 'function'
                ? credential.getClientExtensionResults()
                : {},
            type: credential.type
        };
    }

    function invoke(action, payload) {
        var supabase = window.GM ? window.GM.db : null;
        if (!supabase) return Promise.resolve({ ok: false, error: 'no_client' });
        return supabase.functions.invoke('auth-passkey', {
            body: { action: action, payload: payload || {} }
        }).then(function (r) {
            var data = r && r.data;
            if (!data) return { ok: false, error: (r && r.error && r.error.message) || 'request_failed' };
            return data;
        }).catch(function () {
            return { ok: false, error: 'request_failed' };
        });
    }

    function defaultDeviceLabel() {
        var env = window.GM && typeof window.GM.detectClientEnvironment === 'function'
            ? window.GM.detectClientEnvironment()
            : { os: 'Unknown OS', browser: 'Unknown Browser' };
        return env.browser + ' on ' + env.os;
    }

    // Runs a full registration ceremony (options -> browser prompt -> verify)
    // and enrolls a new passkey for the currently-authenticated account.
    // Resolves { ok, passkey, backupCodes? } — backupCodes is only present
    // when this was the account's first passkey.
    async function registerPasskey(deviceLabel) {
        if (!isSupported()) {
            return { ok: false, error: 'webauthn_unsupported' };
        }

        var optionsRes = await invoke('register-options', {});
        if (!optionsRes.ok) return optionsRes;

        var credential;
        try {
            credential = await navigator.credentials.create({
                publicKey: registrationOptionsFromServer(optionsRes.options)
            });
        } catch (err) {
            return { ok: false, error: (err && err.name === 'NotAllowedError') ? 'cancelled' : 'create_failed' };
        }
        if (!credential) return { ok: false, error: 'cancelled' };

        return invoke('register-verify', {
            credential: registrationCredentialToJSON(credential),
            device_label: (deviceLabel && deviceLabel.trim()) || defaultDeviceLabel()
        });
    }

    // Converts the server's PublicKeyCredentialRequestOptionsJSON into what
    // navigator.credentials.get() expects (ArrayBuffers, not base64url).
    function authenticationOptionsFromServer(options) {
        var publicKey = Object.assign({}, options);
        publicKey.challenge = base64UrlToBuffer(options.challenge);
        if (Array.isArray(options.allowCredentials)) {
            publicKey.allowCredentials = options.allowCredentials.map(function (c) {
                return Object.assign({}, c, { id: base64UrlToBuffer(c.id) });
            });
        }
        return publicKey;
    }

    // Converts the browser's PublicKeyCredential (from get()) into the
    // AuthenticationResponseJSON shape the server's verifyAuthenticationResponse()
    // expects.
    function authenticationCredentialToJSON(credential) {
        var response = credential.response;
        return {
            id: credential.id,
            rawId: bufferToBase64Url(credential.rawId),
            response: {
                clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                authenticatorData: bufferToBase64Url(response.authenticatorData),
                signature: bufferToBase64Url(response.signature),
                userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined
            },
            clientExtensionResults: typeof credential.getClientExtensionResults === 'function'
                ? credential.getClientExtensionResults()
                : {},
            type: credential.type
        };
    }

    // Runs a full authentication ceremony (options -> browser prompt ->
    // verify) for the given account id. Resolves the raw auth-verify
    // response ({ok, role, id, access_token, refresh_token, expires_at,
    // has_passkey}) on success — establishing the actual Supabase session
    // from those tokens is the caller's job, matching how registerPasskey()
    // leaves DB writes to the server and just returns its response.
    // window.GM.loginWithPasskey() in gm-utils.js is that caller.
    async function authenticateWithPasskey(id) {
        if (!isSupported()) return { ok: false, error: 'webauthn_unsupported' };
        if (!id || !id.trim()) return { ok: false, error: 'missing_id' };

        var optionsRes = await invoke('auth-options', { id: id.trim() });
        if (!optionsRes.ok) return optionsRes;

        var credential;
        try {
            credential = await navigator.credentials.get({
                publicKey: authenticationOptionsFromServer(optionsRes.options)
            });
        } catch (err) {
            return { ok: false, error: (err && err.name === 'NotAllowedError') ? 'cancelled' : 'get_failed' };
        }
        if (!credential) return { ok: false, error: 'cancelled' };

        return invoke('auth-verify', {
            id: id.trim(),
            credential: authenticationCredentialToJSON(credential)
        });
    }

    // Redeems a one-time backup code for the given account id. Resolves the
    // same shape as authenticateWithPasskey() on success (plus
    // backup_codes_remaining) — no browser ceremony involved, this is a
    // plain server round trip.
    function redeemBackupCode(id, code) {
        return invoke('backup-login', { id: id, code: code });
    }

    function listPasskeys() {
        return invoke('list', {});
    }

    function renamePasskey(id, deviceLabel) {
        return invoke('rename', { id: id, device_label: deviceLabel });
    }

    function removePasskey(id) {
        return invoke('remove', { id: id });
    }

    function regenerateBackupCodes() {
        return invoke('regenerate-backup-codes', {});
    }

    // Triggers a browser download of the backup codes as a plain-text file.
    // Codes only ever exist in memory client-side for the duration of this
    // call — they're never persisted anywhere except as a hash server-side.
    function downloadBackupCodes(codes, accountId) {
        var lines = [
            'FGF Guild Management Tool — Backup Codes',
            'Account: ' + (accountId || ''),
            'Generated: ' + new Date().toISOString(),
            '',
            'Each code can be used once to sign in if you lose access to all',
            'of your passkeys. Keep this file somewhere safe.',
            ''
        ].concat(codes);
        var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'fgf-backup-codes' + (accountId ? '-' + accountId : '') + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function formatPasskeyDate(iso) {
        if (!iso) return '-';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    // Shared UI builder for the "My Passkeys" card — used identically by the
    // admin Accounts & Access panel and the player Portal's My Info/Security
    // section, so the ~250 lines of list/rename/remove/backup-codes UI logic
    // exist exactly once. Relies on window.GM.showToast (self-contained, safe
    // to call anywhere) and window.showConfirm (defined by app.js, which is
    // always loaded as part of this single-page app regardless of which
    // panel — admin or portal — is currently visible).
    //
    // config: { listEl, addBtnEl, regenBtnEl, regenLabelEl }
    // Returns { reload } — callers decide when the first load happens (e.g.
    // on tab activation), mounting itself makes no network call.
    function mountPasskeysPanel(config) {
        var listEl = config.listEl;
        var addBtnEl = config.addBtnEl;
        var regenBtnEl = config.regenBtnEl;
        var regenLabelEl = config.regenLabelEl;
        var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };

        var lastPasskeys = [];
        var lastBackupCodesRemaining = 0;

        function toast(msg, type) {
            if (window.GM && typeof window.GM.showToast === 'function') window.GM.showToast(msg, type);
        }
        function confirmDialog(title, html, onConfirm) {
            if (typeof window.showConfirm === 'function') window.showConfirm(title, html, onConfirm);
            else if (confirm(title)) onConfirm();
        }

        function render(passkeys, backupCodesRemaining) {
            if (!listEl) return;

            if (regenBtnEl) {
                regenBtnEl.classList.toggle('hidden', passkeys.length === 0);
                if (regenLabelEl) {
                    regenLabelEl.textContent = backupCodesRemaining > 0
                        ? 'Regenerate Backup Codes (' + backupCodesRemaining + ' left)'
                        : 'Generate Backup Codes';
                }
            }

            if (!passkeys.length) {
                listEl.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-fingerprint gm-icon"></i><div class="gm-empty-title">No passkeys yet</div></div>';
                return;
            }

            var html = '<div class="gm-cred-grid">';
            passkeys.forEach(function (pk) {
                html +=
                    '<div class="gm-cred-card" data-passkey-id="' + esc(pk.id) + '">' +
                        '<div class="gm-row" style="justify-content:space-between; align-items:center; margin-bottom: 0.25rem; gap:.5rem;">' +
                            '<div class="gm-passkey-label-wrap" style="display:flex; align-items:center; gap:.4rem; flex:1; min-width:0;">' +
                                '<i class="ph ph-fingerprint" style="color:var(--accent); flex-shrink:0;"></i>' +
                                '<span class="gm-passkey-label" style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(pk.device_label) + '</span>' +
                            '</div>' +
                            '<div class="gm-row" style="gap:.25rem; flex-shrink:0;">' +
                                '<button type="button" class="gm-mini-btn gm-passkey-rename" title="Rename"><i class="ph ph-pencil-simple"></i></button>' +
                                '<button type="button" class="gm-mini-btn gm-danger gm-passkey-remove" title="Remove"><i class="ph ph-trash"></i></button>' +
                            '</div>' +
                        '</div>' +
                        '<div class="gm-row gm-dim" style="font-size:.75rem; gap:.75rem;">' +
                            '<span><i class="ph ph-calendar-blank"></i> Added ' + formatPasskeyDate(pk.created_at) + '</span>' +
                            '<span><i class="ph ph-clock"></i> ' + (pk.last_used_at ? 'Last used ' + formatPasskeyDate(pk.last_used_at) : 'Never used') + '</span>' +
                        '</div>' +
                    '</div>';
            });
            html += '</div>';
            listEl.innerHTML = html;

            listEl.querySelectorAll('.gm-passkey-rename').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var card = btn.closest('.gm-cred-card');
                    var id = card.getAttribute('data-passkey-id');
                    var wrap = card.querySelector('.gm-passkey-label-wrap');
                    var current = card.querySelector('.gm-passkey-label').textContent;

                    var input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'gm-input';
                    input.value = current;
                    input.maxLength = 100;
                    input.style.cssText = 'flex:1; min-width:0; padding:.25rem .5rem; font-size:.9rem;';
                    wrap.innerHTML = '';
                    wrap.appendChild(input);
                    input.focus();
                    input.select();

                    var settled = false;
                    async function commit() {
                        if (settled) return;
                        settled = true;
                        var newLabel = input.value.trim();
                        if (!newLabel || newLabel === current) {
                            render(lastPasskeys, lastBackupCodesRemaining);
                            return;
                        }
                        try {
                            var res = await renamePasskey(id, newLabel);
                            if (!res.ok) throw new Error(res.error || 'rename_failed');
                            toast('Passkey renamed.', 'success');
                            reload();
                        } catch (err) {
                            toast('Could not rename passkey: ' + err.message, 'error');
                            render(lastPasskeys, lastBackupCodesRemaining);
                        }
                    }
                    function cancel() {
                        if (settled) return;
                        settled = true;
                        render(lastPasskeys, lastBackupCodesRemaining);
                    }
                    input.addEventListener('keydown', function (ev) {
                        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
                    });
                    input.addEventListener('blur', commit);
                });
            });

            listEl.querySelectorAll('.gm-passkey-remove').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var card = btn.closest('.gm-cred-card');
                    var id = card.getAttribute('data-passkey-id');
                    var label = card.querySelector('.gm-passkey-label').textContent;
                    confirmDialog(
                        'Remove Passkey',
                        'Remove <strong>' + esc(label) + '</strong>? You won\'t be able to sign in with this device\'s passkey anymore. Your password will still work.',
                        async function () {
                            try {
                                var res = await removePasskey(id);
                                if (!res.ok) throw new Error(res.error || 'remove_failed');
                                toast('Passkey removed.', 'success');
                                reload();
                            } catch (err) {
                                toast('Could not remove passkey: ' + err.message, 'error');
                            }
                        }
                    );
                });
            });
        }

        // Shown exactly once, right after codes are (re)generated — no
        // click-outside-to-close, closing is a conscious "I've saved these" act.
        function showBackupCodesDialog(codes) {
            var existing = document.getElementById('backup-codes-overlay');
            if (existing) existing.remove();

            var accountId = window.GM.currentAccountId || localStorage.getItem('gm_user') || '';
            var codesHtml = codes.map(function (c) {
                return '<div style="padding:.35rem .5rem; background:rgba(255,255,255,0.04); border-radius:4px; text-align:center; letter-spacing:.03em;">' + esc(c) + '</div>';
            }).join('');

            var html =
                '<div id="backup-codes-overlay" class="gm-modal-overlay">' +
                    '<div class="gm-modal-card" style="max-width: 480px; width: 92%;">' +
                        '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom: .75rem;">' +
                            '<i class="ph ph-shield-check" style="font-size: 1.5rem; color: var(--accent);"></i>' +
                            '<h3 style="margin:0; font-size: 1.15rem;">Save Your Backup Codes</h3>' +
                        '</div>' +
                        '<p style="margin-top:0; color: var(--fg-dim); font-size:.9rem;">Each code works once, to sign in if you ever lose access to all your passkeys. This is the only time they\'ll be shown in full — download or copy them now.</p>' +
                        '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:.4rem; font-family: monospace; font-size:.9rem; background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:.75rem; margin: .75rem 0;">' +
                            codesHtml +
                        '</div>' +
                        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
                            '<button type="button" class="gm-btn gm-btn-ghost" id="backup-codes-close">I\'ve saved these</button>' +
                            '<button type="button" class="gm-btn gm-btn-primary" id="backup-codes-download"><i class="ph ph-download-simple"></i> Download</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';

            document.body.insertAdjacentHTML('beforeend', html);
            var overlay = document.getElementById('backup-codes-overlay');
            requestAnimationFrame(function () { overlay.classList.add('visible'); });

            function closeModal() {
                overlay.classList.remove('visible');
                setTimeout(function () { overlay.remove(); }, 200);
            }
            document.getElementById('backup-codes-close').addEventListener('click', closeModal);
            document.getElementById('backup-codes-download').addEventListener('click', function () {
                downloadBackupCodes(codes, accountId);
            });
        }

        async function reload() {
            if (!listEl) return;
            var res = await listPasskeys();
            if (!res.ok) {
                listEl.innerHTML = '<div class="gm-empty"><div class="gm-empty-title">Could not load passkeys.</div></div>';
                return;
            }
            lastPasskeys = res.passkeys || [];
            lastBackupCodesRemaining = res.backupCodesRemaining || 0;
            render(lastPasskeys, lastBackupCodesRemaining);
        }

        if (addBtnEl) {
            if (!isSupported()) {
                addBtnEl.disabled = true;
                addBtnEl.title = 'Passkeys are not supported in this browser.';
            }
            addBtnEl.addEventListener('click', async function () {
                addBtnEl.disabled = true;
                var icon = addBtnEl.querySelector('i');
                var originalIconClass = icon ? icon.className : '';
                if (icon) icon.className = 'ph ph-circle-notch ph-spin';
                try {
                    var res = await registerPasskey();
                    if (!res.ok) {
                        if (res.error === 'cancelled') {
                            // User closed the browser's own passkey prompt — not an error.
                        } else if (res.error === 'webauthn_unsupported') {
                            toast('Passkeys are not supported in this browser.', 'error');
                        } else {
                            toast('Could not add passkey: ' + res.error, 'error');
                        }
                        return;
                    }
                    toast('Passkey added!', 'success');
                    await reload();
                    if (res.backupCodes && res.backupCodes.length) {
                        showBackupCodesDialog(res.backupCodes);
                    }
                } finally {
                    addBtnEl.disabled = false;
                    if (icon) icon.className = originalIconClass;
                }
            });
        }

        if (regenBtnEl) {
            regenBtnEl.addEventListener('click', function () {
                confirmDialog(
                    'Regenerate Backup Codes',
                    'This replaces your existing backup codes with a new set — any old codes will stop working. Continue?',
                    async function () {
                        try {
                            var res = await regenerateBackupCodes();
                            if (!res.ok) throw new Error(res.error || 'regenerate_failed');
                            showBackupCodesDialog(res.backupCodes);
                            reload();
                        } catch (err) {
                            toast('Could not regenerate backup codes: ' + err.message, 'error');
                        }
                    }
                );
            });
        }

        return { reload: reload };
    }

    window.GM = window.GM || {};
    window.GM.webauthn = {
        isSupported: isSupported,
        registerPasskey: registerPasskey,
        authenticateWithPasskey: authenticateWithPasskey,
        redeemBackupCode: redeemBackupCode,
        listPasskeys: listPasskeys,
        renamePasskey: renamePasskey,
        removePasskey: removePasskey,
        regenerateBackupCodes: regenerateBackupCodes,
        downloadBackupCodes: downloadBackupCodes,
        mountPasskeysPanel: mountPasskeysPanel
    };
})();
