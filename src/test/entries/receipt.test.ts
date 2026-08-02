/**
 * Receipts.
 *
 * A receipt acknowledges that money was received. It used to require an
 * obligation, which meant the commonest case of all — a walk-in customer paying
 * cash on the spot, creating no receivable — could not be receipted at all.
 *
 * The model is exposed as JSON so the client can render and print an identical
 * copy. Emailing still renders server-side, because the recipient never loads
 * our page; both read this same model, so the printed and emailed copies cannot
 * drift apart.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { EntriesService } from '../../modules/entries/entries.service';
import { createAccount, createCashbook, createUser, createWorkspace } from '../factories';
import {
    provisionWorkspaceAccounting, ensureCashbookLedgerAccount, ensureWalletLedgerAccount,
} from '../../core/ledger/coa.seed';

const service = () => resolveService(EntriesService);

async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const cashbook = await createCashbook(workspace.id, owner.id, { name: 'Shop' });
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await ensureCashbookLedgerAccount(tx, {
            id: cashbook.id, workspaceId: workspace.id, name: cashbook.name, currency: 'UGX',
        });
    });

    // allowNegative so the money-out case can be built at all: the overdraft
    // guard fires before the receipt logic is ever reached otherwise.
    const wallet = await createAccount(workspace.id, {
        name: 'Till', balance: '0', allowNegative: true,
    });
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const full = await tx.account.findUniqueOrThrow({
            where: { id: wallet.id }, include: { accountType: true },
        });
        await ensureWalletLedgerAccount(tx, full, full.accountType.classification);
    });

    return { owner, workspace, cashbook, wallet };
}

async function customer(workspaceId: string, overrides: { email?: string | null } = {}) {
    return testPrisma.contact.create({
        data: {
            workspaceId,
            name: 'Jane Customer',
            type: 'CUSTOMER',
            email: overrides.email === undefined ? 'jane@example.com' : overrides.email,
        },
    });
}

async function sale(
    f: Awaited<ReturnType<typeof fixture>>,
    contactId: string | null,
    type: 'INCOME' | 'EXPENSE' = 'INCOME',
) {
    return service().createEntry(f.cashbook.id, f.owner.id, {
        type,
        amount: '25000',
        description: 'Two crates of sodas',
        accountId: f.wallet.id,
        contactId: contactId ?? undefined,
        entryDate: new Date('2026-03-10').toISOString(),
    } as never);
}

beforeEach(async () => {
    await resetDatabase();
});

describe('a cash sale with no receivable', () => {
    it('can be receipted — the case that used to be refused', async () => {
        const f = await fixture();
        const contact = await customer(f.workspace.id);
        const entry = await sale(f, contact.id);

        const receipt = await service().getReceiptModel(entry.id);

        expect(receipt.customer.name).toBe('Jane Customer');
        expect(receipt.amountPaid).toBe('25000');
        expect(receipt.currency).toBe('UGX');
    });

    it('carries no obligation block, rather than a zeroed one', async () => {
        // "Balance remaining: 0" on a walk-in sale invites the question of what
        // balance is meant. Absent is clearer than zero.
        const f = await fixture();
        const contact = await customer(f.workspace.id);
        const entry = await sale(f, contact.id);

        const receipt = await service().getReceiptModel(entry.id);

        expect(receipt.obligation).toBeNull();
        expect(receipt.description).toBe('Two crates of sodas');
    });

    it('says whether it can be emailed', async () => {
        const f = await fixture();
        const contact = await customer(f.workspace.id);
        const entry = await sale(f, contact.id);

        expect((await service().getReceiptModel(entry.id)).canEmail).toBe(true);
    });

    it('is still printable when the customer has no email', async () => {
        // The whole reason the flag exists rather than an error: no address is
        // a reason to print, not a reason to refuse a receipt.
        const f = await fixture();
        const contact = await customer(f.workspace.id, { email: null });
        const entry = await sale(f, contact.id);

        const receipt = await service().getReceiptModel(entry.id);

        expect(receipt.canEmail).toBe(false);
        expect(receipt.customer.name).toBe('Jane Customer');
    });

    it('names the business, so the document is usable as a record', async () => {
        const f = await fixture();
        const contact = await customer(f.workspace.id);
        const entry = await sale(f, contact.id);

        const receipt = await service().getReceiptModel(entry.id);

        expect(receipt.business.name).toBe(f.workspace.name);
        expect(receipt.receiptNumber).toBeTruthy();
    });
});

describe('what cannot be receipted', () => {
    it('refuses an entry with no customer', async () => {
        const f = await fixture();
        const entry = await sale(f, null);

        await expect(service().getReceiptModel(entry.id))
            .rejects.toThrow(/not linked to a customer/i);
    });

    it('refuses money going out', async () => {
        // A receipt acknowledges money RECEIVED. Issuing one for an expense
        // would hand a customer a document saying they were paid.
        const f = await fixture();
        const contact = await customer(f.workspace.id);
        const entry = await sale(f, contact.id, 'EXPENSE');

        await expect(service().getReceiptModel(entry.id))
            .rejects.toThrow(/money received|money out/i);
    });

    it('refuses an entry that does not exist', async () => {
        await expect(
            service().getReceiptModel('00000000-0000-0000-0000-000000000000'),
        ).rejects.toThrow();
    });
});
