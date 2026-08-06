/**
 * Expense claims and what approving one does to the books.
 *
 * This is the only place in the projects/tasks work that moves money, so the
 * assertions are about the ledger rather than about status fields: after every
 * approval the trial balance must still be zero, the wallet-link rule must hold
 * (book balance still, money-out moves), and an out-of-pocket claim must land
 * in accounts payable under the claimant's name rather than in the P&L.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { ExpenseClaimsService } from '../../modules/expense-claims/expense-claims.service';
import {
    addWorkspaceMember,
    assignTask,
    createAccount,
    createCashbook,
    createProject,
    createTask,
    createUser,
    createWorkspace,
    getAccount,
    getCashbook,
} from '../factories';
import { WorkspaceRole } from '@prisma/client';
import { provisionWorkspaceAccounting, ensureCashbookLedgerAccount } from '../../core/ledger/coa.seed';

const service = () => resolveService(ExpenseClaimsService);

/** A workspace with accounting provisioned, a book, a wallet, and an assigned task. */
async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const cashbook = await createCashbook(workspace.id, owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await ensureCashbookLedgerAccount(tx, {
            id: cashbook.id, workspaceId: workspace.id, name: cashbook.name, currency: 'UGX',
        });
    });

    const wallet = await createAccount(workspace.id, { name: 'Petty cash', balance: '500000' });
    const member = await createUser();
    await addWorkspaceMember(workspace.id, member.id, WorkspaceRole.MEMBER);

    const project = await createProject(workspace.id, owner.id);
    const task = await createTask(workspace.id, owner.id, { projectId: project.id });
    await assignTask(task.id, member.id, owner.id);

    return { owner, workspace, cashbook, wallet, member, task };
}

/** Attach a receipt straight to the row — the upload path needs MinIO. */
async function attachReceipt(claimId: string, userId: string) {
    return testPrisma.attachment.create({
        data: {
            expenseClaimId: claimId,
            uploadedById: userId,
            fileName: 'receipt.pdf',
            fileSize: 1024,
            mimeType: 'application/pdf',
            s3Key: `test/${claimId}.pdf`,
        },
    });
}

/** Debits minus credits across every journal line in the workspace. */
async function trialBalance(workspaceId: string): Promise<string> {
    const [row] = await testPrisma.$queryRaw<{ diff: Prisma.Decimal }[]>`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS diff
        FROM journal_lines jl
        WHERE jl.workspace_id = ${workspaceId}::uuid
    `;
    return row.diff.toString();
}

async function claimBase(f: Awaited<ReturnType<typeof fixture>>) {
    return {
        taskId: f.task.id,
        amount: '40000',
        currency: 'UGX',
        description: 'Taxi to the site',
        incurredOn: '2026-03-10',
    };
}

beforeEach(async () => {
    await resetDatabase();
});

describe('filing a claim', () => {
    it('lets the assignee claim against their task', async () => {
        const f = await fixture();

        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)),
            paymentSource: 'OWN_MONEY',
        } as any);

        expect(claim.status).toBe('PENDING');
        expect(claim.claimantId).toBe(f.member.id);
        // Inherited from the task, so the claim rolls up to the right project.
        expect(claim.projectId).not.toBeNull();
    });

    it('refuses somebody who is not on the task', async () => {
        const f = await fixture();
        const bystander = await createUser();
        await addWorkspaceMember(f.workspace.id, bystander.id, WorkspaceRole.MEMBER);

        await expect(
            service().createClaim(f.workspace.id, bystander.id, {
                ...(await claimBase(f)),
                paymentSource: 'OWN_MONEY',
            } as any),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses a wallet whose currency does not match the claim', async () => {
        const f = await fixture();
        const usdWallet = await testPrisma.account.update({
            where: { id: f.wallet.id },
            data: { currency: 'USD' },
        });

        await expect(
            service().createClaim(f.workspace.id, f.member.id, {
                ...(await claimBase(f)),
                paymentSource: 'ORG_WALLET',
                accountId: usdWallet.id,
            } as any),
        ).rejects.toBeTruthy();
    });
});

describe('proof is mandatory', () => {
    it('refuses to approve a claim with no receipt', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)),
            paymentSource: 'OWN_MONEY',
        } as any);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any),
        ).rejects.toMatchObject({ code: 'PROOF_REQUIRED' });

        // And nothing was posted on the way to failing.
        expect(await trialBalance(f.workspace.id)).toBe('0');
        const after = await testPrisma.taskExpenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
        expect(after.status).toBe('PENDING');
    });

    it('does not require proof to decline', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)),
            paymentSource: 'OWN_MONEY',
        } as any);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
                approve: false, reviewNote: 'Not a business expense',
            } as any),
        ).resolves.toMatchObject({ status: 'REJECTED' });
    });
});

describe('approving money that left an org wallet', () => {
    async function approved() {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)),
            paymentSource: 'ORG_WALLET',
            accountId: f.wallet.id,
        } as any);
        await attachReceipt(claim.id, f.member.id);
        const result = await service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
            approve: true, cashbookId: f.cashbook.id,
        } as any);
        return { ...f, claim: result };
    }

    it('posts one expense entry and links it to the claim', async () => {
        const { claim, workspace } = await approved();

        expect(claim.status).toBe('APPROVED');
        expect(claim.entryId).not.toBeNull();
        expect(claim.obligationId).toBeNull();
        expect(await trialBalance(workspace.id)).toBe('0');
    });

    it('leaves the book balance alone but moves money-out — the wallet-link rule', async () => {
        const { cashbook } = await approved();

        const book = await getCashbook(cashbook.id);
        expect(book.balance.toString()).toBe('0');
        expect(book.totalExpense.toString()).toBe('40000');
    });

    it('takes the money out of the wallet', async () => {
        const { wallet } = await approved();

        expect((await getAccount(wallet.id)).balance.toString()).toBe('460000');
    });

    it('dates the entry when the expense happened, not when it was approved', async () => {
        const { claim } = await approved();

        const entry = await testPrisma.entry.findUniqueOrThrow({ where: { id: claim.entryId! } });
        expect(entry.entryDate.toISOString().slice(0, 10)).toBe('2026-03-10');
    });
});

describe('approving money the member fronted', () => {
    async function approved() {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)),
            paymentSource: 'OWN_MONEY',
        } as any);
        await attachReceipt(claim.id, f.member.id);
        const result = await service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
            approve: true, cashbookId: f.cashbook.id,
        } as any);
        return { ...f, claim: result };
    }

    it('opens a payable rather than an entry', async () => {
        const { claim, workspace } = await approved();

        expect(claim.obligationId).not.toBeNull();
        expect(claim.entryId).toBeNull();
        expect(await trialBalance(workspace.id)).toBe('0');
    });

    it('owes the money to the claimant, as a staff contact', async () => {
        const { claim, member } = await approved();

        const obligation = await testPrisma.cashbookObligation.findUniqueOrThrow({
            where: { id: claim.obligationId! },
            include: { contact: true },
        });
        expect(obligation.type).toBe('PAYABLE');
        expect(obligation.outstandingAmount.toString()).toBe('40000');
        expect(obligation.contact?.userId).toBe(member.id);
        expect(obligation.contact?.type).toBe('STAFF');
    });

    it('does NOT hit the P&L yet — cash basis, so the expense waits for payment', async () => {
        const { cashbook } = await approved();

        const book = await getCashbook(cashbook.id);
        expect(book.totalExpense.toString()).toBe('0');
        expect(book.balance.toString()).toBe('0');
    });

    it('reuses one staff contact across claims instead of duplicating the person', async () => {
        const f = await fixture();
        for (const description of ['First trip', 'Second trip']) {
            const claim = await service().createClaim(f.workspace.id, f.member.id, {
                ...(await claimBase(f)), description, paymentSource: 'OWN_MONEY',
            } as any);
            await attachReceipt(claim.id, f.member.id);
            await service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any);
        }

        const contacts = await testPrisma.contact.findMany({
            where: { workspaceId: f.workspace.id, userId: f.member.id },
        });
        expect(contacts).toHaveLength(1);
    });
});

describe('the approver has to be able to post to the book they picked', () => {
    it('refuses a book the approver has no access to', async () => {
        // A project manager holds APPROVE_EXPENSE_CLAIM but no
        // ACCESS_ALL_CASHBOOKS, so a book they were never added to is closed.
        const f = await fixture();
        const pm = await createUser();
        await addWorkspaceMember(f.workspace.id, pm.id, WorkspaceRole.PROJECT_MANAGER);
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);
        await attachReceipt(claim.id, f.member.id);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, pm.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(await trialBalance(f.workspace.id)).toBe('0');
    });

    it('allows it once they are added to that book', async () => {
        const f = await fixture();
        const pm = await createUser();
        await addWorkspaceMember(f.workspace.id, pm.id, WorkspaceRole.PROJECT_MANAGER);
        await testPrisma.cashbookMember.create({
            data: { cashbookId: f.cashbook.id, userId: pm.id, role: 'DATA_OPERATOR' },
        });
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);
        await attachReceipt(claim.id, f.member.id);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, pm.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any),
        ).resolves.toMatchObject({ status: 'APPROVED' });
    });

    it('refuses a plain member as the approver', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);
        await attachReceipt(claim.id, f.member.id);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, f.member.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('a claim can only post once', () => {
    it('lets exactly one of two simultaneous approvals through', async () => {
        const f = await fixture();
        const admin = await createUser();
        await addWorkspaceMember(f.workspace.id, admin.id, WorkspaceRole.ADMIN);
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'ORG_WALLET', accountId: f.wallet.id,
        } as any);
        await attachReceipt(claim.id, f.member.id);

        const results = await Promise.allSettled([
            service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any),
            service().reviewClaim(claim.id, f.workspace.id, admin.id, {
                approve: true, cashbookId: f.cashbook.id,
            } as any),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        // The assertion that matters: one entry, not two.
        const entries = await testPrisma.entry.count({ where: { cashbookId: f.cashbook.id } });
        expect(entries).toBe(1);
        expect((await getAccount(f.wallet.id)).balance.toString()).toBe('460000');
        expect(await trialBalance(f.workspace.id)).toBe('0');
    });

    it('refuses a second decision on an already-decided claim', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);
        await attachReceipt(claim.id, f.member.id);
        await service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
            approve: true, cashbookId: f.cashbook.id,
        } as any);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
                approve: false, reviewNote: 'changed my mind',
            } as any),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('cannot be pointed at two postings, even bypassing the service', async () => {
        // Deliberately on a PENDING claim: the approved_is_posted constraint
        // does not apply there, so only one_posting can be what rejects this.
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'ORG_WALLET', accountId: f.wallet.id,
        } as any);

        const entry = await testPrisma.entry.create({
            data: {
                cashbookId: f.cashbook.id,
                type: 'EXPENSE',
                amount: '1',
                description: 'stub',
                entryDate: new Date(),
                createdById: f.owner.id,
            },
        });
        const obligation = await testPrisma.cashbookObligation.create({
            data: {
                workspaceId: f.workspace.id,
                cashbookId: f.cashbook.id,
                type: 'PAYABLE',
                title: 'stub',
                totalAmount: '1',
                // No interest on a reimbursement — principal is the whole of it.
                principalAmount: '1',
                outstandingAmount: '1',
                status: 'OPEN',
            },
        });

        await expect(
            testPrisma.taskExpenseClaim.update({
                where: { id: claim.id },
                data: { entryId: entry.id, obligationId: obligation.id },
            }),
        ).rejects.toThrow(/task_expense_claims_one_posting/);
    });

    it('cannot be marked approved without a posting behind it', async () => {
        // The other half: APPROVED is a claim about the ledger, so the row has
        // to name the document and the book it went into.
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);

        await expect(
            testPrisma.taskExpenseClaim.update({
                where: { id: claim.id },
                data: { status: 'APPROVED', reviewedAt: new Date() },
            }),
        ).rejects.toThrow(/task_expense_claims_approved_is_posted/);
    });
});

describe('declining', () => {
    it('posts nothing at all', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'ORG_WALLET', accountId: f.wallet.id,
        } as any);
        await attachReceipt(claim.id, f.member.id);

        await service().reviewClaim(claim.id, f.workspace.id, f.owner.id, {
            approve: false, reviewNote: 'Use the company account next time',
        } as any);

        expect(await testPrisma.entry.count({ where: { cashbookId: f.cashbook.id } })).toBe(0);
        expect((await getAccount(f.wallet.id)).balance.toString()).toBe('500000');
        expect(await trialBalance(f.workspace.id)).toBe('0');
    });

    it('requires a reason', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);

        await expect(
            service().reviewClaim(claim.id, f.workspace.id, f.owner.id, { approve: false } as any),
        ).rejects.toMatchObject({ code: 'REVIEW_NOTE_REQUIRED' });
    });
});

describe('attachments belong to exactly one thing', () => {
    it('rejects a file with no owner', async () => {
        await expect(
            testPrisma.attachment.create({
                data: {
                    uploadedById: (await createUser()).id,
                    fileName: 'orphan.pdf',
                    fileSize: 1,
                    mimeType: 'application/pdf',
                    s3Key: 'x',
                },
            }),
        ).rejects.toThrow(/attachments_exactly_one_owner/);
    });

    it('rejects a file claimed by two owners', async () => {
        const f = await fixture();
        const claim = await service().createClaim(f.workspace.id, f.member.id, {
            ...(await claimBase(f)), paymentSource: 'OWN_MONEY',
        } as any);

        await expect(
            testPrisma.attachment.create({
                data: {
                    expenseClaimId: claim.id,
                    taskId: f.task.id,
                    uploadedById: f.member.id,
                    fileName: 'confused.pdf',
                    fileSize: 1,
                    mimeType: 'application/pdf',
                    s3Key: 'y',
                },
            }),
        ).rejects.toThrow(/attachments_exactly_one_owner/);
    });

    it('still accepts the original cashbook-owned shape', async () => {
        const f = await fixture();
        await expect(
            testPrisma.attachment.create({
                data: {
                    cashbookId: f.cashbook.id,
                    uploadedById: f.owner.id,
                    fileName: 'invoice.pdf',
                    fileSize: 1,
                    mimeType: 'application/pdf',
                    s3Key: 'z',
                },
            }),
        ).resolves.toBeTruthy();
    });
});
