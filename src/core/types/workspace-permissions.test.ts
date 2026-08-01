/**
 * The workspace permission matrix, asserted role by role.
 *
 * This is a table test on purpose: the matrix is the single place workspace
 * authorization is decided, so a silent widening of any role should fail here
 * rather than in production.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceRole } from './index';
import {
    WorkspacePermission as P,
    assignableRoles,
    hasWorkspacePermission,
} from './workspace-permissions';

const { OWNER, ADMIN, ACCOUNTANT, SUB_ACCOUNTANT, PROJECT_MANAGER, HR, MEMBER } = WorkspaceRole;

/**
 * The whole point of both new roles: they run people and delivery, and see no
 * money at all. If any of these ever flips to true, someone has widened a
 * bundle without noticing.
 */
const FINANCIAL: P[] = [
    P.VIEW_WALLET_BALANCES,
    P.MANAGE_WALLETS,
    P.VIEW_CHART_OF_ACCOUNTS,
    P.MANAGE_CHART_OF_ACCOUNTS,
    P.VIEW_LEDGER,
    P.POST_MANUAL_JOURNAL,
    P.CLOSE_PERIOD,
    P.VIEW_FINANCIAL_REPORTS,
    P.VIEW_INVENTORY,
    P.MANAGE_INVENTORY,
    P.VIEW_INVOICING,
    P.MANAGE_INVOICING,
    P.VIEW_CATALOG,
    P.MANAGE_CATALOG,
    P.CREATE_CASHBOOK,
    P.ACCESS_ALL_CASHBOOKS,
];

describe('WORKSPACE_PERMISSION_MATRIX', () => {
    describe('MEMBER is locked out of every financial surface', () => {
        const forbidden = [
            // VIEW_WALLETS is deliberately absent: a member assigned to a book
            // has to attach entries to wallets and read them back. Balances are
            // what they must not see — asserted separately below.
            P.VIEW_WALLET_BALANCES,
            P.MANAGE_WALLETS,
            P.VIEW_CHART_OF_ACCOUNTS,
            P.VIEW_LEDGER,
            P.VIEW_FINANCIAL_REPORTS,
            P.VIEW_INVENTORY,
            P.MANAGE_INVENTORY,
            P.VIEW_INVOICING,
            P.MANAGE_INVOICING,
            P.VIEW_CATALOG,
            P.MANAGE_CATALOG,
            P.POST_MANUAL_JOURNAL,
            P.CLOSE_PERIOD,
            P.VIEW_AUDIT_LOG,
            P.ACCESS_ALL_CASHBOOKS,
        ];

        it.each(forbidden)('denies %s', (permission) => {
            expect(hasWorkspacePermission(MEMBER, permission)).toBe(false);
        });

        it('still allows non-financial collaboration', () => {
            expect(hasWorkspacePermission(MEMBER, P.USE_PROJECTS)).toBe(true);
            expect(hasWorkspacePermission(MEMBER, P.USE_TASKS)).toBe(true);
            expect(hasWorkspacePermission(MEMBER, P.USE_TIME_TRACKING)).toBe(true);
            expect(hasWorkspacePermission(MEMBER, P.VIEW_WORKSPACE)).toBe(true);
        });

        it('closes the old leak: MEMBER could read inventory valuation and COGS', () => {
            expect(hasWorkspacePermission(MEMBER, P.VIEW_INVENTORY)).toBe(false);
        });

        it('can see which wallets exist, but not what is in them', () => {
            // Without this a member cannot record an entry against a wallet, or
            // see which wallet an existing entry used.
            expect(hasWorkspacePermission(MEMBER, P.VIEW_WALLETS)).toBe(true);
            // The organisation's cash position stays closed.
            expect(hasWorkspacePermission(MEMBER, P.VIEW_WALLET_BALANCES)).toBe(false);
        });
    });

    describe('SUB_ACCOUNTANT', () => {
        const granted = [
            P.VIEW_WALLETS,
            P.VIEW_WALLET_BALANCES,
            P.MANAGE_WALLETS,
            P.VIEW_INVENTORY,
            P.MANAGE_INVENTORY,
            P.VIEW_INVOICING,
            P.MANAGE_INVOICING,
            P.VIEW_FINANCIAL_REPORTS,
            P.VIEW_LEDGER,
        ];

        it.each(granted)('has org-level %s', (permission) => {
            expect(hasWorkspacePermission(SUB_ACCOUNTANT, permission)).toBe(true);
        });

        it('does NOT reach every cashbook — books must be granted explicitly', () => {
            expect(hasWorkspacePermission(SUB_ACCOUNTANT, P.ACCESS_ALL_CASHBOOKS)).toBe(false);
        });

        it('cannot manage members, close periods, or edit the chart of accounts', () => {
            expect(hasWorkspacePermission(SUB_ACCOUNTANT, P.MANAGE_MEMBERS)).toBe(false);
            expect(hasWorkspacePermission(SUB_ACCOUNTANT, P.MANAGE_SUB_ACCOUNTANTS)).toBe(false);
            expect(hasWorkspacePermission(SUB_ACCOUNTANT, P.CLOSE_PERIOD)).toBe(false);
            expect(hasWorkspacePermission(SUB_ACCOUNTANT, P.MANAGE_CHART_OF_ACCOUNTS)).toBe(false);
        });
    });

    describe('ACCOUNTANT', () => {
        it('reaches every cashbook without an explicit membership row', () => {
            expect(hasWorkspacePermission(ACCOUNTANT, P.ACCESS_ALL_CASHBOOKS)).toBe(true);
        });

        it('can manage the chart of accounts and close periods', () => {
            expect(hasWorkspacePermission(ACCOUNTANT, P.MANAGE_CHART_OF_ACCOUNTS)).toBe(true);
            expect(hasWorkspacePermission(ACCOUNTANT, P.CLOSE_PERIOD)).toBe(true);
        });

        it('can add sub-accountants but not general members', () => {
            expect(hasWorkspacePermission(ACCOUNTANT, P.MANAGE_SUB_ACCOUNTANTS)).toBe(true);
            expect(hasWorkspacePermission(ACCOUNTANT, P.MANAGE_MEMBERS)).toBe(false);
        });

        it('cannot delete the workspace or update its settings', () => {
            expect(hasWorkspacePermission(ACCOUNTANT, P.DELETE_WORKSPACE)).toBe(false);
            expect(hasWorkspacePermission(ACCOUNTANT, P.UPDATE_WORKSPACE)).toBe(false);
        });
    });

    describe('PROJECT_MANAGER', () => {
        const granted = [
            P.MANAGE_PROJECTS,
            P.MANAGE_TASKS,
            P.ASSIGN_TASKS,
            P.APPROVE_TASK_WORK,
            P.APPROVE_EXPENSE_CLAIM,
            P.VIEW_WORKER_MONITORING,
            P.LOG_TIME_ON_BEHALF,
            P.EDIT_OTHERS_TIME,
        ];

        it.each(granted)('runs delivery: %s', (permission) => {
            expect(hasWorkspacePermission(PROJECT_MANAGER, permission)).toBe(true);
        });

        it.each(FINANCIAL)('sees no money: %s', (permission) => {
            expect(hasWorkspacePermission(PROJECT_MANAGER, permission)).toBe(false);
        });

        it('reaches a book only through an explicit grant', () => {
            // Approving an expense claim posts to a cashbook, so the book picker
            // must show only books they were actually added to.
            expect(hasWorkspacePermission(PROJECT_MANAGER, P.ACCESS_ALL_CASHBOOKS)).toBe(false);
        });

        it('does not run people operations', () => {
            expect(hasWorkspacePermission(PROJECT_MANAGER, P.MANAGE_ATTENDANCE)).toBe(false);
            expect(hasWorkspacePermission(PROJECT_MANAGER, P.APPROVE_LEAVE)).toBe(false);
            expect(hasWorkspacePermission(PROJECT_MANAGER, P.APPROVE_OVERTIME)).toBe(false);
            expect(hasWorkspacePermission(PROJECT_MANAGER, P.WAIVE_ATTENDANCE_FLAG)).toBe(false);
        });

        it('cannot manage members', () => {
            expect(hasWorkspacePermission(PROJECT_MANAGER, P.MANAGE_MEMBERS)).toBe(false);
            expect(assignableRoles(PROJECT_MANAGER)).toEqual([]);
        });
    });

    describe('HR', () => {
        const granted = [
            P.MANAGE_ATTENDANCE,
            P.VIEW_ALL_ATTENDANCE,
            P.APPROVE_LEAVE,
            P.APPROVE_OVERTIME,
            P.APPROVE_WORK_REPORT,
            P.FORCE_CLOSE_SESSION,
            P.VIEW_WORKER_MONITORING,
            P.LOG_TIME_ON_BEHALF,
            P.EDIT_OTHERS_TIME,
        ];

        it.each(granted)('runs people operations: %s', (permission) => {
            expect(hasWorkspacePermission(HR, permission)).toBe(true);
        });

        it.each(FINANCIAL)('sees no money: %s', (permission) => {
            expect(hasWorkspacePermission(HR, permission)).toBe(false);
        });

        it('onboards and offboards, but only ever as MEMBER', () => {
            expect(hasWorkspacePermission(HR, P.MANAGE_MEMBERS)).toBe(true);
            expect(assignableRoles(HR)).toEqual([MEMBER]);
        });

        it('cannot route around the money ban by promoting someone', () => {
            // If HR could assign ACCOUNTANT they could grant themselves the
            // finances through a second account. MEMBER is the ceiling.
            for (const role of [ADMIN, ACCOUNTANT, SUB_ACCOUNTANT, HR, PROJECT_MANAGER, OWNER]) {
                expect(assignableRoles(HR)).not.toContain(role);
            }
        });

        it('cannot demote an admin, because the target check uses the same list', () => {
            // members.service compares the target's CURRENT role against
            // assignableRoles too, so ADMIN being absent blocks both directions.
            expect(assignableRoles(HR)).not.toContain(ADMIN);
        });

        it('does not run delivery', () => {
            expect(hasWorkspacePermission(HR, P.MANAGE_PROJECTS)).toBe(false);
            expect(hasWorkspacePermission(HR, P.MANAGE_TASKS)).toBe(false);
            expect(hasWorkspacePermission(HR, P.APPROVE_EXPENSE_CLAIM)).toBe(false);
        });

        it('cannot waive an attendance flag it raised', () => {
            // Waiving is an accountability decision; HR owns the policy, so
            // erasing a breach of it sits with the owner or an admin.
            expect(hasWorkspacePermission(HR, P.WAIVE_ATTENDANCE_FLAG)).toBe(false);
        });
    });

    describe('MEMBER gains nothing from the new bundles', () => {
        const forbidden = [
            P.MANAGE_PROJECTS,
            P.MANAGE_TASKS,
            P.ASSIGN_TASKS,
            P.APPROVE_TASK_WORK,
            P.APPROVE_EXPENSE_CLAIM,
            P.MANAGE_ATTENDANCE,
            P.VIEW_ALL_ATTENDANCE,
            P.APPROVE_LEAVE,
            P.APPROVE_OVERTIME,
            P.APPROVE_WORK_REPORT,
            P.FORCE_CLOSE_SESSION,
            P.WAIVE_ATTENDANCE_FLAG,
            P.VIEW_WORKER_MONITORING,
            P.LOG_TIME_ON_BEHALF,
            P.EDIT_OTHERS_TIME,
        ];

        it.each(forbidden)('denies %s', (permission) => {
            expect(hasWorkspacePermission(MEMBER, permission)).toBe(false);
        });

        it('still uses projects, tasks and time tracking', () => {
            expect(hasWorkspacePermission(MEMBER, P.USE_PROJECTS)).toBe(true);
            expect(hasWorkspacePermission(MEMBER, P.USE_TASKS)).toBe(true);
            expect(hasWorkspacePermission(MEMBER, P.USE_TIME_TRACKING)).toBe(true);
        });
    });

    describe('accountants stay out of delivery and people ops', () => {
        it.each([ACCOUNTANT, SUB_ACCOUNTANT])('%s manages neither', (role) => {
            expect(hasWorkspacePermission(role, P.MANAGE_PROJECTS)).toBe(false);
            expect(hasWorkspacePermission(role, P.MANAGE_ATTENDANCE)).toBe(false);
            expect(hasWorkspacePermission(role, P.APPROVE_LEAVE)).toBe(false);
        });
    });

    describe('ADMIN and OWNER', () => {
        it('OWNER holds every permission', () => {
            for (const permission of Object.values(P)) {
                expect(hasWorkspacePermission(OWNER, permission)).toBe(true);
            }
        });

        it('ADMIN holds everything except deleting the workspace and importing members', () => {
            expect(hasWorkspacePermission(ADMIN, P.DELETE_WORKSPACE)).toBe(false);
            expect(hasWorkspacePermission(ADMIN, P.IMPORT_MEMBERS)).toBe(false);
            expect(hasWorkspacePermission(ADMIN, P.MANAGE_MEMBERS)).toBe(true);
            expect(hasWorkspacePermission(ADMIN, P.CLOSE_PERIOD)).toBe(true);
        });
    });

    it('denies everything for an unknown or absent role', () => {
        expect(hasWorkspacePermission(null, P.VIEW_WORKSPACE)).toBe(false);
        expect(hasWorkspacePermission(undefined, P.VIEW_WORKSPACE)).toBe(false);
    });
});

describe('assignableRoles', () => {
    it('lets an accountant move people between member and sub-accountant', () => {
        expect(assignableRoles(ACCOUNTANT).sort()).toEqual([MEMBER, SUB_ACCOUNTANT].sort());
    });

    it('stops an accountant from touching an admin or another accountant', () => {
        // The service checks the target's current role against this list too, so
        // an accountant cannot demote an admin by "assigning" them a lower role.
        expect(assignableRoles(ACCOUNTANT)).not.toContain(ADMIN);
        expect(assignableRoles(ACCOUNTANT)).not.toContain(ACCOUNTANT);
    });

    it('stops an admin from minting another owner', () => {
        expect(assignableRoles(ADMIN)).not.toContain(OWNER);
        expect(assignableRoles(ADMIN)).toContain(ACCOUNTANT);
    });

    it('lets owners and admins appoint project managers and HR', () => {
        for (const actor of [OWNER, ADMIN]) {
            expect(assignableRoles(actor)).toContain(PROJECT_MANAGER);
            expect(assignableRoles(actor)).toContain(HR);
        }
    });

    it('every assignable role is accepted by the invite DTO', () => {
        // members.dto.ts has its own z.enum, which the compiler does NOT check
        // against this list. A role missing there is unassignable by anybody.
        const dtoRoles = ['ADMIN', 'ACCOUNTANT', 'SUB_ACCOUNTANT', 'PROJECT_MANAGER', 'HR', 'MEMBER'];
        for (const role of assignableRoles(OWNER)) {
            expect(dtoRoles).toContain(role);
        }
    });

    it('never lets anyone assign OWNER — ownership comes from creating the workspace', () => {
        for (const role of [OWNER, ADMIN, ACCOUNTANT, SUB_ACCOUNTANT, MEMBER]) {
            expect(assignableRoles(role)).not.toContain(OWNER);
        }
    });

    it('gives sub-accountants and members no assignment rights at all', () => {
        expect(assignableRoles(SUB_ACCOUNTANT)).toEqual([]);
        expect(assignableRoles(MEMBER)).toEqual([]);
    });
});
