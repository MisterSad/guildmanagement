/**
 * RAD MANAGEMENT TOOL – i18n module
 * Usage:  t('key')          → translated string
 *         setLang('en')     → switch language + re-render
 *         applyTranslations() → update all [data-i18n] elements
 */
(function () {

    var TRANSLATIONS = {
        fr: {
            /* ── Login ──────────────────────────── */
            login_title:           'RAD MANAGEMENT',
            login_subtitle:        'Foundation Galactic Frontier',
            login_label_id:        'Identifiant',
            login_placeholder_id:  'Votre identifiant',
            login_label_pass:      'Mot de passe',
            login_placeholder_pass:'Votre mot de passe',
            login_error:           'Identifiants invalides.',
            login_btn:             'Accéder',
            login_btn_loading:     'Connexion...',

            /* ── Admin topbar ──────────────────── */
            nav_dashboard:         'Command Center',
            nav_members:           'Membres',
            nav_admin_label:       'Admin :',
            nav_logout_title:      'Déconnexion',

            /* ── Admin home ────────────────────── */
            admin_title:           'Command Center',
            admin_subtitle:        'Gérez les accès et comptes de la guilde',
            card_create_account:   'Créer un compte',
            label_account_id:      'Identifiant du compte',
            placeholder_account_id:'ex. NomDuMembre',
            btn_generate:          "Générer l'accès",
            btn_generating:        'Création...',
            card_active_accounts:  'Comptes actifs',
            empty_accounts:        'Aucun compte généré',
            copy_title:            'Copier le mot de passe',
            delete_title:          'Supprimer',

            /* ── Guild Members page ────────────── */
            members_title:         'Membres de la Guilde',
            members_subtitle:      'Gérez les membres in-game de Foundation Galactic Frontier',
            card_add_member:       'Ajouter un membre',
            label_pseudo:          'Pseudo in-game',
            placeholder_pseudo:    'ex. StarWarrior99',
            btn_add:               'Ajouter',
            card_member_list:      'Liste des membres',
            empty_members:         'Aucun membre enregistré',
            search_placeholder:    'Rechercher par pseudo ou UID...',

            /* ── Member view ───────────────────── */
            member_home_tab:       'Accueil',
            member_home_title:     'Espace Membre',
            member_home_subtitle:  'Bienvenue sur le portail de la guilde',
            member_greeting:       'Bonjour,',
            member_connected:      "Vous êtes connecté(e) à l'espace membre de",
            member_hint:           'Utilisez le menu ci-dessus pour accéder à la liste des membres.',

            /* ── Toasts ────────────────────────── */
            toast_login_ok:        'Accès accordé. Bienvenue, Admin.',
            toast_welcome:         'Bienvenue,',
            toast_logout:          'Déconnexion réussie.',
            toast_account_created: 'Compte créé avec succès.',
            toast_account_deleted: 'Compte supprimé.',
            toast_member_added:    'ajouté(e) à la guilde !',
            toast_member_removed:  'retiré(e) de la guilde.',
            toast_copied:          'Mot de passe copié !',
            toast_duplicate_account:'Cet identifiant existe déjà !',
            toast_duplicate_member: 'Ce pseudo est déjà dans la guilde !',
            toast_err_fetch_accounts: 'Erreur chargement comptes :',
            toast_err_fetch_members:  'Erreur chargement membres :',
            toast_err_create:      'Échec de la création.',
            toast_err_generic:     'Erreur :',

            /* ── Confirm dialog ────────────────── */
            confirm_delete_account_title:   'Supprimer le compte',
            confirm_delete_account_body:    'Supprimer le compte',
            confirm_delete_account_body2:   '? Cette action est irréversible.',
            confirm_remove_member_title:    'Retirer le membre',
            confirm_remove_member_body:     'Retirer',
            confirm_remove_member_body2:    'de la guilde ?',
            confirm_remove_participant_body: 'Retirer du suivi de participation ?',
            confirm_cancel:        'Annuler',
            confirm_ok:            'Confirmer',

            /* ── Events (generic) ──────────────── */
            event_active:          '🟢 Actif cette semaine',
            event_inactive:        '⚫ Inactif',
            event_activate:        'Activer l\'événement',
            event_deactivate:      'Désactiver',
            event_not_active:      'Cet événement n\'est pas actif cette semaine.',
            event_total:           'membres',
            event_participated:    'participants',
            event_absent:          'absents',
            event_total_score:     'Score total :',
            col_member:            'Membre',
            col_participated:      'A participé',
            col_score:             'Score',

            /* ── Shadowfront ───────────────────── */
            sf_tab_squads:         'Attribution des Squads',
            sf_tab_tracking:       'Suivi de participation',
            sf_squad1:             'Squad 1',
            sf_squad2:             'Squad 2',
            sf_unassigned:         'Non assignés',
            sf_all_assigned:       'Tous les membres sont assignés.',
            sf_no_one:             'Aucun membre',
            sf_participants:       'Participants',
            sf_reserves:           'Réservistes',
            sf_participant:        'Participant',
            sf_reserve:            'Réserviste',
            sf_remove:             'Retirer du squad',
            sf_squad_full:         'Ce slot est complet !',
            sf_tracking_title:     'Suivi de participation',
            sf_squad_col:          'Squad / Rôle',
            sf_subtitle:           'Squad 1 & Squad 2 — 20 participants + 10 réservistes',
            sf_cat_regular:        'Régulier',
            sf_cat_rotation:       'À faire tourner',
            sf_cat_occasional:     'Occasionnel',
            sf_filter_all:         'Tous',
            sf_filter_regular:     'Réguliers',
            sf_filter_rotation:    'À tourner',
            sf_hist_attended:      'participations',
            sf_hist_never:         'Jamais assigné',
            sf_no_match_filter:    'Aucun membre dans cette catégorie.',

            /* ── Glory tracker ────────────── */
            glory_title:           'Suivi de la Gloire',
            glory_subtitle:        'Gloire gagnée par les membres cette semaine',
            glory_gained:          'Cette semaine',
            glory_total:           'Total guilde :',
            glory_prev_week:       'Semaine précédente',
            glory_this_week:       'Semaine en cours',
            glory_input:           'Saisie',
            glory_evolution:       'Évolution',
            glory_evolution_pct:   'Évolution (%)',
            glory_vs_prev:         'Comparaison vs semaine précédente active',

            /* ── Stats ────────────────────── */
            nav_stats:             'Stats',
            stats_subtitle:        'Classement et évolution des membres de la guilde',
            stats_compute:         'Recalculer',
            stats_no_data:         'Aucune donnée disponible pour cette semaine.',
            stats_score:           'Note /20',
            stats_events:          'Événements',
            stats_glory:           'Glory',
            stats_profile:         'Profil',
            stats_see_profile:     'Voir le profil',
            stats_week:            'Semaine',
            
            /* ── Sanctions ────────────────── */
            nav_sanctions:         'Sanctions',
            sanctions_title:       'Suivi des Sanctions',
            sanctions_subtitle:    'Gérez et historisez les manquements des membres',
            label_target_player:   'Membre concerné',
            placeholder_target_player: 'Rechercher un membre...',
            label_comment:         'Commentaire / Motif',
            btn_apply_sanction:    'Appliquer la sanction',
            sanctions_history:     'Historique des sanctions',
            alert_recidivist:      '🚨 ALERTE RÉCIDIVISTE 🚨\nCe joueur vient de cumuler sa 3ème sanction ou plus !',
            toast_sanction_added:  'Sanction enregistrée avec succès.',
            col_date:              'Date',
            col_reason:            'Motif / Commentaire',
            confirm_delete_sanction_title: 'Supprimer la sanction',
            confirm_delete_sanction_body:  'Voulez-vous vraiment supprimer cette sanction ? Cette action est irréversible.',
        },

        en: {
            /* ── Login ──────────────────────────── */
            login_title:           'RAD MANAGEMENT',
            login_subtitle:        'Foundation Galactic Frontier',
            login_label_id:        'Identifier',
            login_placeholder_id:  'Your identifier',
            login_label_pass:      'Password',
            login_placeholder_pass:'Your password',
            login_error:           'Invalid credentials.',
            login_btn:             'Access',
            login_btn_loading:     'Logging in...',

            /* ── Admin topbar ──────────────────── */
            nav_dashboard:         'Command Center',
            nav_members:           'Members',
            nav_admin_label:       'Admin:',
            nav_logout_title:      'Logout',

            /* ── Admin home ────────────────────── */
            admin_title:           'Command Center',
            admin_subtitle:        'Manage access and accounts for the guild',
            card_create_account:   'Create Account',
            label_account_id:      'Account Identifier',
            placeholder_account_id:'e.g. MemberName',
            btn_generate:          'Generate Access',
            btn_generating:        'Creating...',
            card_active_accounts:  'Active Accounts',
            empty_accounts:        'No accounts generated',
            copy_title:            'Copy password',
            delete_title:          'Delete',

            /* ── Guild Members page ────────────── */
            members_title:         'Guild Members',
            members_subtitle:      'Manage in-game members of Foundation Galactic Frontier',
            card_add_member:       'Add a member',
            label_pseudo:          'In-game username',
            placeholder_pseudo:    'e.g. StarWarrior99',
            btn_add:               'Add',
            card_member_list:      'Members list',
            empty_members:         'No members registered',
            search_placeholder:    'Search by username or UID...',

            /* ── Member view ───────────────────── */
            member_home_tab:       'Home',
            member_home_title:     'Member Space',
            member_home_subtitle:  'Welcome to the guild portal',
            member_greeting:       'Hello,',
            member_connected:      'You are connected to the member space of',
            member_hint:           'Use the menu above to access the guild member list.',

            /* ── Toasts ────────────────────────── */
            toast_login_ok:        'Access granted. Welcome back, Admin.',
            toast_welcome:         'Welcome,',
            toast_logout:          'Successfully logged out.',
            toast_account_created: 'Account created successfully.',
            toast_account_deleted: 'Account deleted.',
            toast_member_added:    'added to the guild!',
            toast_member_removed:  'removed from the guild.',
            toast_copied:          'Password copied!',
            toast_duplicate_account:'This identifier already exists!',
            toast_duplicate_member: 'This username is already in the guild!',
            toast_err_fetch_accounts: 'Error loading accounts:',
            toast_err_fetch_members:  'Error loading members:',
            toast_err_create:      'Creation failed.',
            toast_err_generic:     'Error:',

            /* ── Confirm dialog ────────────────── */
            confirm_delete_account_title:   'Delete account',
            confirm_delete_account_body:    'Delete account',
            confirm_delete_account_body2:   '? This action is irreversible.',
            confirm_remove_member_title:    'Remove member',
            confirm_remove_member_body:     'Remove',
            confirm_remove_member_body2:    'from the guild?',
            confirm_remove_participant_body: 'Remove from participation tracking?',
            confirm_cancel:        'Cancel',
            confirm_ok:            'Confirm',

            /* ── Events (generic) ──────────────── */
            event_active:          '🟢 Active this week',
            event_inactive:        '⚫ Inactive',
            event_activate:        'Activate event',
            event_deactivate:      'Deactivate',
            event_not_active:      'This event is not active this week.',
            event_total:           'members',
            event_participated:    'participated',
            event_absent:          'absent',
            event_total_score:     'Total score:',
            col_member:            'Member',
            col_participated:      'Participated',
            col_score:             'Score',

            /* ── Shadowfront ───────────────────── */
            sf_tab_squads:         'Squad Assignment',
            sf_tab_tracking:       'Participation Tracking',
            sf_squad1:             'Squad 1',
            sf_squad2:             'Squad 2',
            sf_unassigned:         'Unassigned',
            sf_all_assigned:       'All members are assigned.',
            sf_no_one:             'No members',
            sf_participants:       'Participants',
            sf_reserves:           'Reserves',
            sf_participant:        'Participant',
            sf_reserve:            'Reserve',
            sf_remove:             'Remove from squad',
            sf_squad_full:         'This slot is full!',
            sf_tracking_title:     'Participation tracking',
            sf_squad_col:          'Squad / Role',
            sf_subtitle:           'Squad 1 & Squad 2 — 20 participants + 10 reserves',
            sf_cat_regular:        'Regular',
            sf_cat_rotation:       'Due for rotation',
            sf_cat_occasional:     'Occasional',
            sf_filter_all:         'All',
            sf_filter_regular:     'Regulars',
            sf_filter_rotation:    'Due for rotation',
            sf_hist_attended:      'attendances',
            sf_hist_never:         'Never assigned',
            sf_no_match_filter:    'No members in this category.',

            /* ── Glory tracker ────────────── */
            glory_title:           'Glory Tracker',
            glory_subtitle:        'Glory gained by members this week',
            glory_gained:          'This week',
            glory_total:           'Guild total:',
            glory_prev_week:       'Previous week',
            glory_this_week:       'This week',
            glory_input:           'Input',
            glory_evolution:       'Evolution',
            glory_evolution_pct:   'Evolution (%)',
            glory_vs_prev:         'Comparison vs previous week',

            /* ── Stats ────────────────────── */
            nav_stats:             'Stats',
            stats_subtitle:        'Rankings and member evolution',
            stats_compute:         'Recompute',
            stats_no_data:         'No data available for this week.',
            stats_score:           'Score /20',
            stats_events:          'Events',
            stats_glory:           'Glory',
            stats_profile:         'Profile',
            stats_see_profile:     'View profile',
            stats_week:            'Week',

            /* ── Sanctions ────────────────── */
            nav_sanctions:         'Sanctions',
            sanctions_title:       'Sanctions Tracking',
            sanctions_subtitle:    'Manage and history member infractions',
            label_target_player:   'Target Member',
            placeholder_target_player: 'Search for a member...',
            label_comment:         'Comment / Reason',
            btn_apply_sanction:    'Apply Sanction',
            sanctions_history:     'Sanctions History',
            alert_recidivist:      '🚨 RECIDIVIST ALERT 🚨\nThis player has just accumulated their 3rd sanction or more!',
            toast_sanction_added:  'Sanction successfully recorded.',
            col_date:              'Date',
            col_reason:            'Reason / Comment',
            confirm_delete_sanction_title: 'Delete sanction',
            confirm_delete_sanction_body:  'Do you really want to delete this sanction? This action is irreversible.',
        }
    };

    // ── Public API ─────────────────────────────────────────────────────────────
    var currentLang = localStorage.getItem('rad_lang') || 'en';

    window.RAD_I18N = {
        t: function (key) {
            return (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key])
                || (TRANSLATIONS['en'] && TRANSLATIONS['en'][key])
                || key;
        },
        getLang: function () { return currentLang; },
        setLang: function (lang) {
            if (!TRANSLATIONS[lang]) return;
            currentLang = lang;
            localStorage.setItem('rad_lang', lang);
            window.RAD_I18N.applyTranslations();
            // Update switcher button states
            document.querySelectorAll('.lang-btn').forEach(function (btn) {
                btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
            });
        },
        applyTranslations: function () {
            var t = window.RAD_I18N.t;
            // Text content
            document.querySelectorAll('[data-i18n]').forEach(function (el) {
                el.textContent = t(el.getAttribute('data-i18n'));
            });
            // Placeholder attributes
            document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
                el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
            });
            // Title attributes
            document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
                el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
            });
        }
    };

})();
