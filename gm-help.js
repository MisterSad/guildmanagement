/**
 * gm-help.js — Contextual help system
 * Provides small (i) info buttons beside section titles.
 * Clicking one opens a popover with plain-English guidance for guild admins & players.
 */
(function () {
    'use strict';

    var HELP_DB = {
        // ====================================================
        // ADMIN - Accounts & Access
        // ====================================================
        'help-create-account': {
            icon: 'ph-key',
            title: 'New Account',
            body: '<p>Create a login account for a guild admin. Enter a username (e.g. the person\'s in-game name), select the guild, and click <strong>Generate Access</strong>.</p><p>A secure password is generated automatically. Copy and share it with the admin - they can use it to log in immediately.</p><p>The account gets <strong>Guild Admin</strong> access and can only manage their own guild\'s data.</p>'
        },
        'help-active-accounts': {
            icon: 'ph-shield-check',
            title: 'Active Admin Accounts',
            body: '<p>Lists all admin accounts for your guild. For each account you can:</p><ul><li><i class="ph ph-arrow-counter-clockwise"></i> <strong>Reset password</strong> - generates a new password and shows it once. The old password is immediately invalidated.</li><li><i class="ph ph-trash"></i> <strong>Delete</strong> - permanently removes the account. The person will no longer be able to log in.</li></ul>'
        },
        'help-member-accounts': {
            icon: 'ph-users-three',
            title: 'Player Portal Accounts',
            body: '<p>Lists player accounts created via the <strong>Join Code</strong> self-registration flow.</p><p>Players with status <strong>Pending</strong> are waiting for your approval before they can access the portal. Click <i class="ph ph-check"></i> to approve or <i class="ph ph-x"></i> to reject.</p><p>Approved players can log into the <strong>Player Portal</strong> to update their power, declare absences, and view their event history.</p>'
        },
        'help-join-code': {
            icon: 'ph-key',
            title: 'Guild Join Code',
            body: '<p>This is the unique code for your guild. Give it to players who want to self-register on the Player Portal.</p><p>On the login screen, players enter their <strong>username</strong> and this <strong>Join Code</strong> to create an account. Their account will be <em>pending</em> until you approve it in the <strong>Player Portal Accounts</strong> section above.</p><p>The code is permanent and never changes - you can freely share it in Discord.</p>'
        },

        // ====================================================
        // ADMIN - Discord Notifications
        // ====================================================
        'help-guild-config': {
            icon: 'ph-sliders',
            title: 'Guild Configuration & Event Coefficients',
            body: '<p><strong>Server #</strong>: your 4-digit game server number. Used when building cross-server rankings.</p><p><strong>Coefficients</strong> control how much each event type counts toward the overall participation score leaderboard. Higher coefficient = more weight in rankings. Example: if SvS is your main event, set its coefficient higher than others.</p>'
        },
        'help-discord-role': {
            icon: 'ph-at',
            title: 'Global Discord Role Mention',
            body: '<p>Set the Discord Role ID that will be pinged in every event notification. To find it:</p><ol><li>Enable <strong>Developer Mode</strong> in Discord Settings → Advanced.</li><li>Go to your server\'s <strong>Roles</strong> settings.</li><li>Right-click the role → <strong>Copy Role ID</strong>.</li></ol><p>Leave blank to send notifications without any mention.</p>'
        },
        'help-webhooks': {
            icon: 'ph-webhook',
            title: 'Notification Webhooks',
            body: '<p>Webhooks let the tool post event announcements directly into your Discord channels. To create one:</p><ol><li>Open Discord → channel settings → <strong>Integrations</strong> → <strong>Webhooks</strong>.</li><li>Click <strong>New Webhook</strong>, give it a name and select the channel.</li><li>Copy the webhook URL and paste it into the field here.</li></ol><p>Each event type can have its own dedicated channel webhook.</p>'
        },
        'help-reminders': {
            icon: 'ph-bell-ringing',
            title: 'Event Reminders',
            body: '<p>Automated reminder messages sent to Discord <em>before</em> an event starts. The reminder is triggered by the event\'s scheduled start time and uses the webhook you configured for that event type.</p><p>Enable or disable reminders per event type. You can also customize the lead time (e.g. 30 minutes before).</p>'
        },

        // ====================================================
        // ADMIN - Members
        // ====================================================
        'help-members-list': {
            icon: 'ph-users',
            title: 'Member Roster',
            body: '<p>The full list of your guild\'s members. You can:</p><ul><li><strong>Search</strong> by name using the filter box.</li><li><strong>Sort</strong> by power, rank, or name.</li><li><strong>Edit</strong> a member (click <i class="ph ph-pencil"></i>) to update their username, UID, power, or rank.</li><li><strong>Delete</strong> a member (click <i class="ph ph-trash"></i>) to remove them from the roster entirely.</li><li><strong>Add</strong> a new member using the form at the top.</li></ul><p>Changes propagate to all event participation records that reference this member.</p>'
        },
        'help-pending-transfers': {
            icon: 'ph-arrows-left-right',
            title: 'Pending Guild Transfers',
            body: '<p>When a player requests to move to another guild via the Player Portal, a transfer request appears here.</p><p>Approve to move the player to their requested guild (their portal account follows them). Reject to keep them in your guild.</p>'
        },
        'help-absences': {
            icon: 'ph-calendar-x',
            title: 'Member Absences',
            body: '<p>Players can declare upcoming absences through the Player Portal. This section shows all declared absences so you can plan your event rosters accordingly.</p><p>Absences are informational only - they do not automatically affect participation tracking.</p>'
        },
        'help-timezones': {
            icon: 'ph-globe-hemisphere-west',
            title: 'Member Timezones',
            body: '<p>Shows the UTC timezone offset declared by each player in the Player Portal. Useful for scheduling events across different regions.</p><p>The offset is set by the player themselves and is informational - it doesn\'t change how event times are displayed.</p>'
        },

        // ====================================================
        // EVENTS
        // ====================================================
        'help-event-svs': {
            icon: 'ph-sword',
            title: 'Server vs Server (SvS)',
            body: '<p>Tracks participation for the weekly SvS event. To use:</p><ol><li>Click <strong>Start SvS</strong> to open the current week\'s session.</li><li>Check off the members who participated (or import from Discord).</li><li>Set each player\'s score if applicable.</li><li>Click <strong>Validate</strong> to save. The session auto-groups by ISO week.</li></ol><p>Re-opening the same week reuses the existing session - no duplicate data.</p>'
        },
        'help-event-gvg': {
            icon: 'ph-flag-banner',
            title: 'Guild vs Guild (GvG)',
            body: '<p>Tracks weekly GvG participation. Start a session for the current week, mark participants, optionally log scores, then validate.</p><p>GvG counts once per ISO week per player, regardless of how many battles happen in that week.</p>'
        },
        'help-event-shadowfront': {
            icon: 'ph-shield-chevron',
            title: 'Shadowfront',
            body: '<p>Manage Shadowfront Squads 1 and 2. Each squad session is separate and runs weekly.</p><p>Assign players to squads, track participation per session. Players not in a squad are not tracked for that session.</p>'
        },
        'help-event-dtr': {
            icon: 'ph-truck',
            title: 'Defend Trade Route (DTR)',
            body: '<p>Track participation for each DTR session (identified by date). One session per calendar day.</p><p>Start a session, mark participants, validate. Multiple DTR sessions in the same week each count separately in the participation score.</p>'
        },
        'help-event-armsrace': {
            icon: 'ph-target',
            title: 'Arms Race',
            body: '<p>Arms Race has two stages: <strong>Stage A</strong> and <strong>Stage B</strong>. Each stage is a separate session tracked by date.</p><p>Scoring: Stage A and Stage B count independently - a player who does both A and B in the same week earns two participation points.</p>'
        },
        'help-event-glory': {
            icon: 'ph-trophy',
            title: 'Glory',
            body: '<p>Record weekly Glory scores per player. Each entry is keyed to the ISO week.</p><p>You can enter scores manually or import from a Discord message. The leaderboard ranks players by Glory earned in the selected week.</p>'
        },
        'help-event-history': {
            icon: 'ph-clock-counter-clockwise',
            title: 'Event History',
            body: '<p>Browse all past event sessions across all event types. Filter by event type or date range.</p><p>Click a session to see the full participant list and scores for that session.</p>'
        },

        // ====================================================
        // STATS
        // ====================================================
        'help-stats': {
            icon: 'ph-chart-bar',
            title: 'Guild Statistics',
            body: '<p>A dashboard of key performance indicators for your guild:</p><ul><li><strong>Participation rate</strong>: % of members attending events over the selected period, counting distinct sessions (not duplicate rows).</li><li><strong>Power distribution</strong>: how combat power is spread across ranks.</li><li><strong>Top 5 share</strong>: how much of total guild power the top 5 players hold.</li></ul><p>Use the period selector (2 weeks / 4 weeks / all time) to adjust the time window.</p>'
        },

        // ====================================================
        // SANCTIONS & BANNED
        // ====================================================
        'help-sanctions': {
            icon: 'ph-warning-octagon',
            title: 'Sanctions',
            body: '<p>Log disciplinary actions for members (warnings, bench, removal).</p><ul><li>Select the member, pick a sanction type, and add a reason.</li><li>Sanctions are visible to all admins of your guild.</li><li>A sanction does not automatically restrict access - it is a record-keeping tool.</li></ul>'
        },
        'help-banned': {
            icon: 'ph-prohibit',
            title: 'Banned Players',
            body: '<p>Permanently block a player UID from joining your guild via the Player Portal.</p><p>Add the player\'s UID and an optional reason. They will be rejected at self-registration even if they have the correct join code.</p><p>Remove the ban by clicking <i class="ph ph-trash"></i> next to the entry.</p>'
        },

        // ====================================================
        // PLAYER PORTAL
        // ====================================================
        'help-portal-dashboard': {
            icon: 'ph-house',
            title: 'Your Dashboard',
            body: '<p>Your personal overview in the guild management tool. Here you can see:</p><ul><li>Your current <strong>rank</strong> and <strong>combat power</strong>.</li><li>Your <strong>participation badges</strong> earned from attending events.</li><li>A summary of your recent event activity.</li></ul>'
        },
        'help-portal-power': {
            icon: 'ph-sword',
            title: 'Update Your Power',
            body: '<p>Enter your current in-game <strong>Overall Combat Power</strong> and click Save. Your guild admin uses this to track roster strength.</p><p>Update it regularly - especially after a major troop upgrade or research completion.</p>'
        },
        'help-portal-absence': {
            icon: 'ph-calendar-x',
            title: 'Declare an Absence',
            body: '<p>Let your guild admins know in advance if you won\'t be available for events.</p><p>Enter the start and end dates of your absence and an optional reason, then click <strong>Save Absence</strong>. Your guild admin will see it in the Members tab.</p>'
        },
        'help-portal-timezone': {
            icon: 'ph-globe-hemisphere-west',
            title: 'Your Timezone',
            body: '<p>Set your UTC timezone offset so your guild admin knows what time events fall in your local time.</p><p>For example: UTC+2 → enter <strong>+2</strong>. UTC-5 → enter <strong>-5</strong>.</p>'
        },
        'help-portal-transfer': {
            icon: 'ph-arrows-left-right',
            title: 'Request a Guild Transfer',
            body: '<p>If you want to move to a different guild, use this form to submit a transfer request.</p><p>Your current guild admin will be notified and must approve the transfer. Once approved, your account automatically follows you to the new guild and your history is preserved.</p>'
        },
        'help-portal-events': {
            icon: 'ph-calendar-check',
            title: 'Active Events',
            body: '<p>Lists the events currently open for score submission by your guild. Select the event, enter your score or mark your participation, and click <strong>Submit</strong>.</p><p>Your submission is reviewed by your admin before it is validated.</p>'
        }
    };

    var popover = null;

    function createPopover() {
        var el = document.createElement('div');
        el.id = 'gm-help-popover';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.innerHTML =
            '<div class="gm-help-backdrop"></div>' +
            '<div class="gm-help-panel">' +
                '<div class="gm-help-panel-header">' +
                    '<div class="gm-help-panel-icon"><i id="gm-help-icon" class="ph"></i></div>' +
                    '<span id="gm-help-title" class="gm-help-panel-title"></span>' +
                    '<button class="gm-help-close" aria-label="Close help" id="gm-help-close-btn">' +
                        '<i class="ph ph-x"></i>' +
                    '</button>' +
                '</div>' +
                '<div id="gm-help-body" class="gm-help-panel-body"></div>' +
            '</div>';
        document.body.appendChild(el);

        el.querySelector('.gm-help-backdrop').addEventListener('click', closeHelp);
        el.querySelector('#gm-help-close-btn').addEventListener('click', closeHelp);
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') closeHelp();
        });
        return el;
    }

    function openHelp(id) {
        var data = HELP_DB[id];
        if (!data) return;
        if (!popover) popover = createPopover();
        popover.querySelector('#gm-help-icon').className = 'ph ' + data.icon;
        popover.querySelector('#gm-help-title').textContent = data.title;
        popover.querySelector('#gm-help-body').innerHTML = data.body;
        popover.classList.add('gm-help-open');
        popover.querySelector('#gm-help-close-btn').focus();
    }

    function closeHelp() {
        if (popover) popover.classList.remove('gm-help-open');
    }

    function init() {
        document.addEventListener('click', function (ev) {
            var btn = ev.target.closest('[data-help-id]');
            if (!btn) return;
            ev.stopPropagation();
            openHelp(btn.getAttribute('data-help-id'));
        });
    }

    window.GM_HELP = {
        open: openHelp,
        close: closeHelp,
        init: init
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
