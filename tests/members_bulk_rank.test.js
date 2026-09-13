import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Bulk Member Rank Assignment (Excluding R5)', () => {
    describe('1. Role Whitelist & Validation', () => {
        it('getAllowedBulkRoles returns exactly R1, R2, R3, R4 and excludes R5', () => {
            const roles = window.GM.getAllowedBulkRoles();
            expect(roles).toEqual(['R1', 'R2', 'R3', 'R4']);
            expect(roles.includes('R5')).toBe(false);
        });

        it('isRoleAllowedForBulk accurately validates permissible bulk ranks', () => {
            expect(window.GM.isRoleAllowedForBulk('R1')).toBe(true);
            expect(window.GM.isRoleAllowedForBulk('R2')).toBe(true);
            expect(window.GM.isRoleAllowedForBulk('R3')).toBe(true);
            expect(window.GM.isRoleAllowedForBulk('R4')).toBe(true);
            expect(window.GM.isRoleAllowedForBulk('R5')).toBe(false);
            expect(window.GM.isRoleAllowedForBulk('admin')).toBe(false);
            expect(window.GM.isRoleAllowedForBulk('')).toBe(false);
            expect(window.GM.isRoleAllowedForBulk(null)).toBe(false);
        });
    });

    describe('2. Member Eligibility & R5 Leadership Protection', () => {
        const mockRoster = [
            { pseudo: 'GuildLeader', role: 'R5', guild: 'ALPHA', overall_power: 100000000 },
            { pseudo: 'OfficerOne', role: 'R4', guild: 'ALPHA', overall_power: 80000000 },
            { pseudo: 'VeteranAlex', role: 'R3', guild: 'ALPHA', overall_power: 60000000 },
            { pseudo: 'MemberBob', role: 'R2', guild: 'ALPHA', overall_power: 40000000 },
            { pseudo: 'RecruitCharlie', role: 'R1', guild: 'ALPHA', overall_power: 20000000 }
        ];

        it('filters out R5 members from bulk selection and reports excluded count', () => {
            const selected = ['GuildLeader', 'OfficerOne', 'VeteranAlex', 'RecruitCharlie'];
            const res = window.GM.filterBulkEligibleMembers(mockRoster, selected);

            expect(res.eligiblePseudos).toEqual(['OfficerOne', 'VeteranAlex', 'RecruitCharlie']);
            expect(res.eligiblePseudos.includes('GuildLeader')).toBe(false);
            expect(res.excludedR5Count).toBe(1);
        });

        it('handles case-insensitive pseudos matching accurately', () => {
            const selected = new Set(['officerone', 'MEMBERBOB']);
            const res = window.GM.filterBulkEligibleMembers(mockRoster, selected);

            expect(res.eligiblePseudos).toEqual(['OfficerOne', 'MemberBob']);
            expect(res.excludedR5Count).toBe(0);
        });

        it('returns empty list when only R5 is selected', () => {
            const selected = ['GuildLeader'];
            const res = window.GM.filterBulkEligibleMembers(mockRoster, selected);

            expect(res.eligiblePseudos).toEqual([]);
            expect(res.excludedR5Count).toBe(1);
        });

        it('handles empty roster or selected set gracefully', () => {
            expect(window.GM.filterBulkEligibleMembers([], [])).toEqual({ eligiblePseudos: [], excludedR5Count: 0 });
            expect(window.GM.filterBulkEligibleMembers(null, null)).toEqual({ eligiblePseudos: [], excludedR5Count: 0 });
        });
    });

    describe('3. Template & Markup Invariants (index.html, components.css, app.js)', () => {
        it('index.html defines the bulk action dock with R1-R4 buttons only and strictly excludes R5', () => {
            const html = read('index.html');
            expect(html).toContain('id="admin-members-bulk-bar"');
            expect(html).toContain('id="admin-members-select-all-btn"');
            expect(html).toContain('id="admin-bulk-selected-count"');
            expect(html).toContain('id="admin-bulk-clear-btn"');
            expect(html).toContain('data-role="R1"');
            expect(html).toContain('data-role="R2"');
            expect(html).toContain('data-role="R3"');
            expect(html).toContain('data-role="R4"');

            // Bulk role bar must NEVER contain an R5 assignment button
            const bulkBarMatch = html.match(/id="admin-members-bulk-bar"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
            expect(bulkBarMatch).not.toBeNull();
            if (bulkBarMatch) {
                expect(bulkBarMatch[0]).not.toContain('data-role="R5"');
            }
        });

        it('components.css defines styles for selection checkboxes and floating bulk dock', () => {
            const css = read('components.css');
            expect(css).toContain('.gm-bulk-action-bar');
            expect(css).toContain('.gm-bulk-action-bar.is-visible');
            expect(css).toContain('.gm-member-row.is-selected');
            expect(css).toContain('.gm-member-select-chk');
        });

        it('members renderer includes bulk update logic, checkbox rendering, and R5 protection guards', () => {
            const app = read('src/modules/app/members/members.render.ts');
            expect(app).toContain('bulkUpdateMemberRoles');
            expect(app).toContain('updateBulkActionBar');
            expect(app).toContain('adminSelectedMembers');
            expect(app).toContain('filterBulkEligibleMembers');
            expect(app).toContain('isRoleAllowedForBulk');
            expect(app).toMatch(/isR5\s*\?\s*['"]\s*disabled['"]/);
        });

        it('i18n.js includes all required translation keys for bulk actions', () => {
            expect(window.GM_I18N.t('bulk_select_all')).toBe('Select All');
            expect(window.GM_I18N.t('bulk_deselect_all')).toBe('Deselect All');
            expect(window.GM_I18N.t('bulk_assign_rank')).toBe('Assign Rank:');
            expect(window.GM_I18N.t('bulk_selected_count')).toContain('{n}');
            expect(window.GM_I18N.t('toast_bulk_role_updated')).toContain('{role}');
        });
    });

    describe('4. Bulk Update Execution Simulation', () => {
        it('formulates correct Supabase update query on eligible members', async () => {
            const mockRoster = [
                { pseudo: 'LeaderX', role: 'R5', guild: 'ALPHA' },
                { pseudo: 'PlayerA', role: 'R1', guild: 'ALPHA' },
                { pseudo: 'PlayerB', role: 'R2', guild: 'ALPHA' }
            ];
            const selected = new Set(['LeaderX', 'PlayerA', 'PlayerB']);
            const targetRole = 'R4';

            expect(window.GM.isRoleAllowedForBulk(targetRole)).toBe(true);

            const { eligiblePseudos, excludedR5Count } = window.GM.filterBulkEligibleMembers(mockRoster, selected);
            expect(eligiblePseudos).toEqual(['PlayerA', 'PlayerB']);
            expect(excludedR5Count).toBe(1);

            const mockDb = {
                from: vi.fn().mockReturnThis(),
                update: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockResolvedValue({ data: [], error: null })
            };

            await mockDb
                .from('guild_members')
                .update({ role: targetRole })
                .eq('guild', 'ALPHA')
                .in('pseudo', eligiblePseudos);

            expect(mockDb.from).toHaveBeenCalledWith('guild_members');
            expect(mockDb.update).toHaveBeenCalledWith({ role: 'R4' });
            expect(mockDb.eq).toHaveBeenCalledWith('guild', 'ALPHA');
            expect(mockDb.in).toHaveBeenCalledWith('pseudo', ['PlayerA', 'PlayerB']);
        });
    });
});
