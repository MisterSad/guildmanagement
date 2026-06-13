/**
 * push.js — Web Push opt-in (anonymous per-device).
 *
 * Registers the service worker, exposes RAD_PUSH.mount(container) to render
 * an opt-in control whose label reflects the current state, and stores the
 * subscription server-side via the save_push_subscription RPC.
 *
 * iOS note: PushManager only exists inside an installed PWA (iOS 16.4+).
 * In a plain Safari tab we surface an "add to home screen" hint instead.
 */
(function () {

    var VAPID_PUBLIC = (window.GMT_CONFIG || {}).VAPID_PUBLIC_KEY || '';

    var t   = window.RAD ? window.RAD.t : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    var swReg = null;

    var supported = ('serviceWorker' in navigator) &&
                    ('PushManager' in window) &&
                    ('Notification' in window);

    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    function isStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
               navigator.standalone === true;
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').then(function (reg) {
                swReg = reg;
            }).catch(function (e) { console.error('sw register', e); });
        });
    }

    function urlBase64ToUint8Array(base64String) {
        var padding = '='.repeat((4 - base64String.length % 4) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(base64);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function byteArraysEqual(a, b) {
        if (a.byteLength !== b.byteLength) return false;
        var ua = new Uint8Array(a);
        var ub = new Uint8Array(b);
        for (var i = 0; i < ua.length; i++) {
            if (ua[i] !== ub[i]) return false;
        }
        return true;
    }

    async function getReg() {
        if (swReg) return swReg;
        if ('serviceWorker' in navigator) {
            swReg = await navigator.serviceWorker.register('/sw.js');
            return swReg;
        }
        return null;
    }

    async function currentSubscription() {
        try {
            var reg = await getReg();
            if (!reg) return null;
            var sub = await reg.pushManager.getSubscription();
            if (sub && sub.options && sub.options.applicationServerKey) {
                var expected = urlBase64ToUint8Array(VAPID_PUBLIC);
                if (!byteArraysEqual(sub.options.applicationServerKey, expected)) {
                    // Public key mismatch! Unsubscribe to force resubscription with the new key.
                    await sub.unsubscribe();
                    return null;
                }
            }
            return sub;
        } catch (e) { return null; }
    }

    async function enable() {
        try {
            var perm = await Notification.requestPermission();
            if (perm !== 'granted') {
                window.RAD.showToast(t(perm === 'denied' ? 'push_blocked' : 'push_toast_err'), 'error');
                return;
            }
            var reg = await getReg();
            if (!reg) { window.RAD.showToast(t('push_toast_err'), 'error'); return; }
            var sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
                });
            }
            var j = sub.toJSON();
            var res = await window.RAD.db.rpc('save_push_subscription', {
                p_endpoint: j.endpoint,
                p_p256dh:   j.keys && j.keys.p256dh,
                p_auth:     j.keys && j.keys.auth,
                p_ua:       (navigator.userAgent || '').slice(0, 300)
            });
            if (res.error) throw res.error;
            window.RAD.showToast(t('push_toast_on'), 'success');
        } catch (e) {
            console.error('push enable', e);
            window.RAD.showToast(t('push_toast_err'), 'error');
        }
        renderAll();
    }

    async function disable() {
        try {
            var sub = await currentSubscription();
            if (sub) await sub.unsubscribe();
            window.RAD.showToast(t('push_toast_off'), 'info');
        } catch (e) { console.error('push disable', e); }
        renderAll();
    }

    var mounted = [];

    async function render(container) {
        if (!container) return;

        if (!supported) {
            var msg = (isIOS && !isStandalone()) ? t('push_ios_hint') : t('push_unsupported');
            container.innerHTML = '<div class="gm-push-optin gm-dim">' +
                '<i class="ph ph-bell-slash"></i> ' + esc(msg) + '</div>';
            return;
        }
        if (Notification.permission === 'denied') {
            container.innerHTML = '<div class="gm-push-optin gm-dim">' +
                '<i class="ph ph-bell-slash"></i> ' + esc(t('push_blocked')) + '</div>';
            return;
        }

        var sub = await currentSubscription();
        if (sub && Notification.permission === 'granted') {
            container.innerHTML = '<div class="gm-push-optin">' +
                '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-bell-ringing"></i> ' + esc(t('push_enabled')) + '</span>' +
                '<button class="gm-btn gm-btn-ghost gm-btn-sm gm-push-off" type="button">' + esc(t('push_disable')) + '</button>' +
                '</div>';
            var off = container.querySelector('.gm-push-off');
            if (off) off.addEventListener('click', disable);
        } else {
            container.innerHTML = '<div class="gm-push-optin">' +
                '<button class="gm-btn gm-btn-success gm-btn-sm gm-push-on" type="button">' +
                    '<i class="ph ph-bell-ringing"></i> ' + esc(t('push_enable')) +
                '</button></div>';
            var on = container.querySelector('.gm-push-on');
            if (on) on.addEventListener('click', enable);
        }
    }

    function renderAll() {
        mounted = mounted.filter(function (el) { return el && el.isConnected; });
        mounted.forEach(function (el) { render(el); });
    }

    window.RAD_PUSH = {
        mount: function (container) {
            if (!container) return;
            if (mounted.indexOf(container) === -1) mounted.push(container);
            render(container);
        }
    };

})();
