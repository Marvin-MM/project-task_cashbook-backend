/**
 * A working gate, built the way the application builds one.
 *
 * Deliberately goes through the real services rather than writing rows: if
 * provisioning stops seeding the book's ledger account, or a session can no
 * longer be created with the tiers it needs, these tests should fail rather than
 * pass against a fixture that has quietly diverged from what production does.
 */
import { Prisma } from '@prisma/client';
import { testPrisma } from '../setup';
import { resolveService } from '../container';
import { createAccount, createUser, createWorkspace, addWorkspaceMember } from '../factories';
import { provisionWorkspaceAccounting, ensureWalletLedgerAccount } from '../../core/ledger/coa.seed';
import { TicketingConfigService } from '../../modules/ticketing/ticketing-config.service';
import { TicketingService, DeskActor } from '../../modules/ticketing/ticketing.service';
import { MembershipsService } from '../../modules/ticketing/memberships.service';
import { WorkspaceRole, StaffTag, FeatureKey } from '../../core/types';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { ticketDeskCapabilities } from '../../core/authz/ticketing-access';

export const ticketing = () => resolveService(TicketingService);
export const ticketConfig = () => resolveService(TicketingConfigService);
export const memberships = () => resolveService(MembershipsService);

/** Build the actor a route guard would have produced for this user. */
export function actorFor(
    userId: string,
    role: WorkspaceRole,
    staffTag: StaffTag | null = null,
): DeskActor {
    return { userId, role, staffTag, capabilities: ticketDeskCapabilities(role, staffTag) };
}

export interface GateFixture {
    owner: { id: string };
    attendant: { id: string };
    otherAttendant: { id: string };
    workspace: { id: string };
    wallet: { id: string };
    mobileMoney: { id: string };
    cashbookId: string;
    sessionId: string;
    adultTypeId: string;
    minorTypeId: string;
    ownerActor: DeskActor;
    attendantActor: DeskActor;
    otherAttendantActor: DeskActor;
}

interface GateOptions {
    /** 0-6. Defaults to whatever weekday "today" is, so the desk finds a session. */
    dayOfWeek?: number;
    adultPrice?: string;
    minorPrice?: string;
    capacity?: number | null;
    /** Add the "adult free with 2+ minors" offer. */
    guardianComp?: boolean;
    dayStartMinutes?: number;
}

export async function buildGate(options: GateOptions = {}): Promise<GateFixture> {
    const owner = await createUser();
    const attendant = await createUser();
    const otherAttendant = await createUser();
    const workspace = await createWorkspace(owner.id);

    await addWorkspaceMember(workspace.id, attendant.id, WorkspaceRole.MEMBER);
    await addWorkspaceMember(workspace.id, otherAttendant.id, WorkspaceRole.MEMBER);
    await testPrisma.workspaceMember.updateMany({
        where: { workspaceId: workspace.id, userId: { in: [attendant.id, otherAttendant.id] } },
        data: { staffTag: StaffTag.TICKETING },
    });

    // The superadmin's half: unlock the module for this org.
    await testPrisma.workspaceFeature.create({
        data: {
            workspaceId: workspace.id,
            feature: FeatureKey.TICKETING,
            enabledById: owner.id,
        },
    });

    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const wallet = await createAccount(workspace.id, { name: 'Gate cash tin', balance: '0' });
    const mobileMoney = await createAccount(workspace.id, { name: 'MTN MoMo', balance: '0' });
    for (const account of [wallet, mobileMoney]) {
        await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const full = await tx.account.findUniqueOrThrow({
                where: { id: account.id }, include: { accountType: true },
            });
            await ensureWalletLedgerAccount(tx, full, full.accountType.classification);
        });
    }

    // The org's half: a book for gate takings and a category to count it as.
    const provisioned = await ticketConfig().provision(workspace.id, owner.id, {
        cashbookName: 'Gate / Tickets',
        categoryName: 'Ticket Sales',
    });

    if (options.dayStartMinutes !== undefined) {
        await ticketConfig().updateSettings(workspace.id, owner.id, {
            dayStartMinutes: options.dayStartMinutes,
        });
    }

    const dayOfWeek = options.dayOfWeek ?? new Date().getDay();
    const session = await ticketConfig().createSession(workspace.id, owner.id, {
        name: 'Tonight',
        dayOfWeek,
        capacity: options.capacity ?? null,
    } as any);

    const adult = await ticketConfig().createTicketType(
        workspace.id, session.id, owner.id,
        { name: 'Adult', patronClass: 'ADULT', price: options.adultPrice ?? '20000' } as any,
    );
    const minor = await ticketConfig().createTicketType(
        workspace.id, session.id, owner.id,
        { name: 'Minor', patronClass: 'MINOR', price: options.minorPrice ?? '10000' } as any,
    );

    if (options.guardianComp) {
        await ticketConfig().createDiscountRule(workspace.id, owner.id, {
            sessionId: session.id,
            name: 'Guardian goes free',
            type: 'GUARDIAN_COMP',
            valueType: 'PERCENT',
            value: '100',
            config: { minMinors: 2, compPatronClass: 'ADULT', maxCompPerSale: 1 },
            priority: 10,
            stackable: false,
        } as any);
    }

    return {
        owner,
        attendant,
        otherAttendant,
        workspace,
        wallet,
        mobileMoney,
        cashbookId: provisioned.cashbook.id,
        sessionId: session.id,
        adultTypeId: adult.id,
        minorTypeId: minor.id,
        ownerActor: actorFor(owner.id, WorkspaceRole.OWNER),
        attendantActor: actorFor(attendant.id, WorkspaceRole.MEMBER, StaffTag.TICKETING),
        otherAttendantActor: actorFor(otherAttendant.id, WorkspaceRole.MEMBER, StaffTag.TICKETING),
    };
}

/**
 * The books must balance. Summed across every journal line in the database,
 * because a ticketing bug that posted a one-sided entry would show up here and
 * nowhere else in these tests.
 */
export async function trialBalance(): Promise<string> {
    const rows = await testPrisma.journalLine.aggregate({
        _sum: { debit: true, credit: true },
    });
    return new Prisma.Decimal(rows._sum.debit ?? 0)
        .sub(rows._sum.credit ?? 0)
        .toString();
}

export async function walletBalance(accountId: string): Promise<string> {
    const account = await testPrisma.account.findUniqueOrThrow({ where: { id: accountId } });
    return account.balance.toString();
}

export async function cashbookTotals(cashbookId: string) {
    const book = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: cashbookId } });
    return {
        balance: book.balance.toString(),
        totalIncome: book.totalIncome.toString(),
        totalExpense: book.totalExpense.toString(),
    };
}

export const CAN_MANAGE = WorkspacePermission.MANAGE_TICKETING;
