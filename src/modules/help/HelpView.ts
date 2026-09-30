/**
 * src/modules/help/HelpView.ts
 *
 * Strangler Phase 1 port of the root `gm-help.js` contextual help system.
 * Renders small (i) info buttons' popover with plain-English guidance. The
 * `#gm-help-popover` DOM and the delegated `[data-help-id]` click wiring are
 * preserved verbatim.
 *
 * This module never assigns `window.GM_HELP` (parity bridge is added at cutover
 * in src/main.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HelpEntry {
  icon: string;
  title: string;
  body: string;
}

export const HELP_DB: Record<string, HelpEntry> = {
  // ====================================================
  // ADMIN - Accounts & Access
  // ====================================================
  'help-my-passkeys': {
    icon: 'ph-fingerprint',
    title: 'My Passkeys',
    body: '<p>A passkey lets you sign in with your device\'s fingerprint, face, or PIN instead of typing your password every time. It never leaves your device.</p><p>You can register a passkey on each device you use (phone, laptop...) and give each one a name so you can tell them apart.</p><p>Your password keeps working exactly as before - a passkey is an extra option, not a replacement.</p><p>The first time you add a passkey, you\'ll also get a set of one-time <strong>backup codes</strong> to download - keep them somewhere safe in case you ever lose access to all your passkeys.</p>'
  },
  'help-create-account': {
    icon: 'ph-key',
    title: 'New Account',
    body: '<p>Create a login for an officer. Enter a username (e.g. their in-game name), select the guild, and click <strong>Generate Access</strong>.</p><p>A secure password is generated and <strong>shown once</strong> on the new account, already copied for you. Send it privately: nobody can read it again later, but you can always issue a new one with <strong>Renew Password</strong>.</p><p>Prefer no password at all? Use <strong>Invite an Admin</strong>: the officer signs in with Discord.</p>'
  },
  'help-active-accounts': {
    icon: 'ph-shield-check',
    title: 'Active Admin Accounts',
    body: '<p>Lists all admin accounts for your guild. For each account you can:</p><ul><li><i class="ph ph-arrow-counter-clockwise"></i> <strong>Reset password</strong> - generates a new password and shows it once. The old password is immediately invalidated.</li><li><i class="ph ph-trash"></i> <strong>Delete</strong> - permanently removes the account. The person will no longer be able to log in.</li></ul>'
  },
  'help-member-accounts': {
    icon: 'ph-users-three',
    title: 'Player Portal Accounts',
    body: '<p>Lists player accounts created when players join with your <strong>Join Code</strong> (Sign in with Discord → Join a guild).</p><p>Players with status <strong>Pending</strong> are waiting for your approval before they can access the portal. Click <i class="ph ph-check"></i> to approve or <i class="ph ph-x"></i> to reject.</p><p>Approved players can use the <strong>Player Portal</strong> to report event participation, update their stats and declare absences.</p>'
  },
  'help-join-code': {
    icon: 'ph-key',
    title: 'Guild Join Code',
    body: '<p>The permanent code players use to join your guild.</p><p>A player clicks <strong>Sign in with Discord</strong> → <strong>Join a guild</strong>, then enters this code and their <strong>in-game UID</strong>. Their UID must already be on your member list. Their account stays <em>pending</em> until you approve it in <strong>Pending Account Validations</strong>.</p><p>The code never changes. Share it in your guild\'s Discord.</p>'
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
  'help-migration-groups': {
    icon: 'ph-arrows-left-right',
    title: 'Cross-Server Migration Groups',
    body: '<p>When the game opens a temporary migration window grouping several servers together, a super admin opens a group here listing those server numbers.</p><p>While a group is <strong>open</strong>, admins on any linked server can transfer players to a guild on any other linked server, in addition to the usual same-server transfers.</p><p>Close the group once the game\'s migration window ends - this immediately turns off eligibility for further cross-server transfers, and even a transfer request that was made while the group was open cannot be approved after it closes.</p>'
  },
  'help-webhooks': {
    icon: 'ph-webhooks-logo',
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
    body: '<p>Your guild\'s member list, in two views:</p><ul><li><strong>Roster Cards</strong>: grouped by rank, with power, UID, time zone and absences.</li><li><strong>Military Matrix</strong>: every stat side by side, with the Rally Score and the top 16 rally leaders.</li></ul><p>Search by name or UID, filter by tier, and sort with the menu. On a card: <i class="ph ph-pencil"></i> edit, <i class="ph ph-arrows-left-right"></i> transfer, <i class="ph ph-trash"></i> delete.</p><p><strong>Deleting a member also deletes their history</strong>: use Transfer when they move to another guild. The R5 cannot be deleted: change their rank first.</p><p>Update everyone\'s stats at once with <strong>AI Metric Scanners</strong>.</p>'
  },
  'help-pending-transfers': {
    icon: 'ph-arrows-left-right',
    title: 'Pending Guild Transfers',
    body: '<p>Pending moves between your guild and another one. Whoever asked for a move never decides it:</p><ul><li><strong>A player asked to join you</strong> (Player Portal): <strong>you</strong> approve or reject it.</li><li><strong>Another guild asked to take one of your players</strong>: <strong>you</strong> approve or reject it.</li><li><strong>You asked to take a player</strong>: the player\'s current guild decides. You can withdraw your request.</li></ul><p>An approved move takes the player\'s history and portal account with them. There is no notification: check this list regularly.</p>'
  },
  'help-absences': {
    icon: 'ph-calendar-x',
    title: 'Member Absences',
    body: '<p>Players can declare upcoming absences through the Player Portal. This section shows all declared absences so you can plan your event rosters accordingly.</p><p>Absences are informational only - they do not automatically affect participation tracking.</p>'
  },
  'help-timezones': {
    icon: 'ph-globe-hemisphere-west',
    title: 'Member Timezones',
    body: '<p>What time it is right now for each member, based on the time zone they (or an officer) declared. The peak hour shows when most of your guild is awake: a good time for events.</p><p>Players set it in the Player Portal; officers can set it in Edit member.</p>'
  },

  // ====================================================
  // EVENTS
  // ====================================================
  'help-event-svs': {
    icon: 'ph-sword',
    title: 'Server vs Server (SvS)',
    body: '<p>Tracks the weekly SvS. To use:</p><ol><li>Click <strong>Start</strong> and set the start time (UTC). All members are added automatically.</li><li>Tick <strong>Participated</strong> and enter the day scores, by hand or with the OCR buttons. Everything saves by itself.</li><li>Mark each day Won / Lost in the war banner.</li><li>Click <strong>End</strong> when the week is over.</li></ol><p>SvS counts once per week in Stats. Starting again in the same week reuses the same session.</p>'
  },
  'help-event-gvg': {
    icon: 'ph-flag-banner',
    title: 'Guild vs Guild (GvG)',
    body: '<p>Tracks the weekly GvG, like SvS: <strong>Start</strong> (UTC time), fill in participation and day scores (by hand or OCR), mark days Won / Lost, then <strong>End</strong>.</p><p>GvG counts once per week per player in Stats, however many battles happen.</p>'
  },
  'help-event-shadowfront': {
    icon: 'ph-shield-chevron',
    title: 'Shadowfront',
    body: '<p>Squad One and Squad Two each have their own session.</p><ol><li><strong>1. Squad Composition</strong>: pick up to 20 main players and 10 substitutes.</li><li><strong>2. Participation Tracking</strong>: tick who played, who was late, excused, or a substitute who showed up.</li></ol><p>Only squad members are tracked. Shadowfront counts once per week in Stats. A session ends by itself 24 hours after it starts.</p>'
  },
  'help-event-dtr': {
    icon: 'ph-truck',
    title: 'Defend Trade Route (DTR)',
    body: '<p>Each DTR run is its own session: you can run several in one day. Start it (UTC time), tick <strong>Appointed</strong> and <strong>Participated</strong>, then End it.</p><p>Every session counts separately in Stats. A session ends by itself 24 hours after it starts.</p>'
  },
  'help-event-armsrace': {
    icon: 'ph-target',
    title: 'Arms Race',
    body: '<p>Arms Race has two stages, <strong>Stage A</strong> and <strong>Stage B</strong>, each with its own sessions.</p><p>Each session counts separately in Stats: a player who does both stages earns two participations. A session ends by itself 24 hours after it starts.</p>'
  },
  'help-event-glory': {
    icon: 'ph-trophy',
    title: 'Glory',
    body: '<p>Enter each member\'s Glory for the current week (Monday 00:00 UTC to Sunday). It saves by itself as you type, and <strong>Evolution</strong> compares with last week.</p><p>Faster: <strong>Members → AI Metric Scanners → 8. Glory OCR</strong>, or players use <code>/update-stats glory:</code> in Discord. To fix a past week, use History → Glory.</p><p>Glory does not count in Reliability.</p>'
  },
  'help-event-history': {
    icon: 'ph-clock-counter-clockwise',
    title: 'Event History',
    body: '<p>Every past session, newest first. Filter by event type.</p><p>Click a session to see every participant and <strong>fix mistakes</strong>: participation, scores, late, excused. Each change saves immediately.</p><p><strong>Delete</strong> erases a session\'s scores for good. The "Delete … history" button erases every session of that type, including the running one.</p>'
  },

  // ====================================================
  // STATS
  // ====================================================
  'help-stats': {
    icon: 'ph-chart-bar',
    title: 'Guild Statistics',
    body: '<p>Who shows up, and how reliably.</p><ul><li><strong>Guild Cockpit</strong>: engagement, war record, power progression and data completeness.</li><li><strong>Leaderboard</strong>: each member\'s attendance per event and <strong>Reliability</strong>, a weighted score (SvS and GvG count most; set the weights in Discord notifications → Event Coefficients).</li><li><strong>Event Deep-Dive</strong>: one event type in detail.</li></ul><p>Excused sessions are not counted; late still counts as present; pending player submissions count once approved.</p>'
  },

  // ====================================================
  // SANCTIONS & BANNED
  // ====================================================
  'help-sanctions': {
    icon: 'ph-warning-octagon',
    title: 'Sanctions',
    body: '<p>A warning log for your guild.</p><ul><li>Pick the member, write the reason, click <strong>Apply Sanction</strong>.</li><li>From the 3rd sanction, a recidivist alert reminds you.</li><li>Sanctions are visible to your guild\'s admins and follow a player who is transferred.</li><li>A sanction does not restrict anything: it is a record-keeping tool.</li></ul>'
  },
  'help-banned': {
    icon: 'ph-prohibit',
    title: 'Banned Players',
    body: '<p>A per-guild blacklist of player UIDs.</p><p>A banned UID is <strong>removed from your member list</strong> (which deletes their history) and cannot be added back, by hand, OCR or transfer. It also cannot join with your join code, and the Discord bot refuses them your guild role.</p><p>Remove the ban with <i class="ph ph-trash"></i>. The player is not added back automatically.</p>'
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
  'help-portal-discord-link': {
    icon: 'ph-discord-logo',
    title: 'Link Discord',
    body: '<p>Type <code>/link</code> in Discord to get a one-time code, then paste it here to confirm. Confirming here — while you\'re already signed in — is what proves the Discord account is really yours.</p><p>Once linked, player commands like <code>/myinfo</code> work in Discord for your account.</p>'
  },
  'help-portal-transfer': {
    icon: 'ph-arrows-left-right',
    title: 'Request a Guild Transfer',
    body: '<p>If you want to move to a different guild, use this form to submit a transfer request.</p><p>The officers of the guild you want to join decide. There is no notification, so let them know on Discord. Once approved, your account automatically follows you to the new guild and your history is preserved.</p>'
  },
  'help-portal-events': {
    icon: 'ph-calendar-check',
    title: 'Active Events',
    body: '<p>The events your guild is running right now. Tick <strong>I participated in this event</strong>, add your score if there is a box, and click <strong>Submit</strong>.</p><p>It shows <strong>Awaiting approval</strong> until an officer confirms it, then <strong>Confirmed by an officer</strong>.</p>'
  }
};

export class HelpView {
  private popover: HTMLElement | null = null;
  private initialized = false;
  private keydownHandler?: (ev: KeyboardEvent) => void;

  public open(id: string): void {
    const data = HELP_DB[id];
    if (!data) return;
    if (!this.popover) this.popover = this.createPopover();
    const pop = this.popover as HTMLElement;
    const icon = pop.querySelector('#gm-help-icon');
    const title = pop.querySelector('#gm-help-title');
    const body = pop.querySelector('#gm-help-body');
    if (icon) icon.className = 'ph ' + data.icon;
    if (title) title.textContent = data.title;
    if (body) body.innerHTML = data.body;
    pop.classList.add('gm-help-open');
    const closeBtn = pop.querySelector('#gm-help-close-btn') as HTMLElement | null;
    if (closeBtn) closeBtn.focus();
  }

  public close(): void {
    if (this.popover) this.popover.classList.remove('gm-help-open');
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;
    document.addEventListener('click', (ev) => {
      const target = ev.target as Element | null;
      const btn = target ? target.closest('[data-help-id]') : null;
      if (!btn) return;
      ev.stopPropagation();
      this.open(btn.getAttribute('data-help-id') || '');
    });
  }

  public destroy(): void {
    if (this.popover && this.popover.parentNode) this.popover.parentNode.removeChild(this.popover);
    this.popover = null;
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = undefined;
    }
    this.initialized = false;
  }

  private createPopover(): HTMLElement {
    const el = document.createElement('div');
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

    const backdrop = el.querySelector('.gm-help-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => this.close());
    const closeBtn = el.querySelector('#gm-help-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    this.keydownHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.keydownHandler);
    return el;
  }
}

/** Shared singleton instance (bridged to `window.GM_HELP` at cutover). */
export const helpView = new HelpView();

export default helpView;
