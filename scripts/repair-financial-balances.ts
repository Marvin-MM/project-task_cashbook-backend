/**
 * Non-destructive repair of denormalized financial caches.
 *
 * Recomputes:
 *  - Cashbook balance / totalIncome / totalExpense (charge + wallet-link aware)
 *  - Account balances from non-voided AccountTransactions + AccountTransfers
 *  - Obligation status from outstanding vs total
 *  - Invoice amountPaid / amountDue / status from linked obligations
 *
 * Usage:
 *   npx tsx scripts/repair-financial-balances.ts --dry-run
 *   npx tsx scripts/repair-financial-balances.ts --apply
 *
 * Never deletes user rows.
 */
import 'dotenv/config';
import { PrismaClient, ObligationStatus, InvoiceStatus } from '@prisma/client';
import {
    recomputeCashbookFromEntries,
    recomputeWalletBalance,
    obligationStatusFromAmounts,
    invoiceStatusFromOutstanding,
} from '../src/core/finance';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const dryRun = !apply;

type Diff = {
    entity: string;
    id: string;
    field: string;
    oldValue: string;
    newValue: string;
};

async function main() {
    const diffs: Diff[] = [];
    console.log(dryRun ? '=== DRY RUN (no writes) ===' : '=== APPLY MODE ===');

    // ── Cashbooks ──────────────────────────────────────
    const cashbooks = await prisma.cashbook.findMany({ select: { id: true, name: true, balance: true, totalIncome: true, totalExpense: true } });
    console.log(`Cashbooks: ${cashbooks.length}`);

    for (const cb of cashbooks) {
        const entries = await prisma.entry.findMany({
            where: { cashbookId: cb.id, isDeleted: false },
            select: {
                type: true,
                amount: true,
                chargeAmount: true,
                accountTransactions: {
                    where: { voidedAt: null },
                    select: { id: true },
                    take: 1,
                },
            },
        });

        const computed = recomputeCashbookFromEntries(
            entries.map((e) => ({
                type: e.type,
                amount: e.amount,
                chargeAmount: e.chargeAmount,
                hasWalletLink: e.accountTransactions.length > 0,
            })),
        );

        if (!cb.balance.equals(computed.balance)) {
            diffs.push({ entity: 'cashbook', id: cb.id, field: 'balance', oldValue: cb.balance.toString(), newValue: computed.balance.toString() });
        }
        if (!cb.totalIncome.equals(computed.totalIncome)) {
            diffs.push({ entity: 'cashbook', id: cb.id, field: 'totalIncome', oldValue: cb.totalIncome.toString(), newValue: computed.totalIncome.toString() });
        }
        if (!cb.totalExpense.equals(computed.totalExpense)) {
            diffs.push({ entity: 'cashbook', id: cb.id, field: 'totalExpense', oldValue: cb.totalExpense.toString(), newValue: computed.totalExpense.toString() });
        }

        if (!dryRun && (
            !cb.balance.equals(computed.balance) ||
            !cb.totalIncome.equals(computed.totalIncome) ||
            !cb.totalExpense.equals(computed.totalExpense)
        )) {
            await prisma.cashbook.update({
                where: { id: cb.id },
                data: {
                    balance: computed.balance,
                    totalIncome: computed.totalIncome,
                    totalExpense: computed.totalExpense,
                },
            });
        }
    }

    // ── Accounts ───────────────────────────────────────
    const accounts = await prisma.account.findMany({ select: { id: true, balance: true, workspaceId: true } });
    console.log(`Accounts: ${accounts.length}`);

    for (const account of accounts) {
        const transactions = await prisma.accountTransaction.findMany({
            where: { accountId: account.id, voidedAt: null },
            select: { type: true, amount: true, chargeAmount: true },
        });

        const transfers = await prisma.accountTransfer.findMany({
            where: {
                voidedAt: null,
                OR: [{ fromAccountId: account.id }, { toAccountId: account.id }],
            },
            select: { fromAccountId: true, toAccountId: true, amount: true, feeAmount: true },
        });

        const computed = recomputeWalletBalance(
            transactions,
            transfers.map((t) =>
                t.fromAccountId === account.id
                    ? { direction: 'OUT' as const, amount: t.amount, feeAmount: t.feeAmount }
                    : { direction: 'IN' as const, amount: t.amount },
            ),
        );

        if (!account.balance.equals(computed)) {
            diffs.push({
                entity: 'account',
                id: account.id,
                field: 'balance',
                oldValue: account.balance.toString(),
                newValue: computed.toString(),
            });
            if (!dryRun) {
                await prisma.account.update({
                    where: { id: account.id },
                    data: { balance: computed },
                });
            }
        }
    }

    // ── Obligations ────────────────────────────────────
    const obligations = await prisma.cashbookObligation.findMany({
        select: {
            id: true,
            totalAmount: true,
            outstandingAmount: true,
            status: true,
            referenceType: true,
            referenceId: true,
        },
    });
    console.log(`Obligations: ${obligations.length}`);

    for (const o of obligations) {
        const newStatus = obligationStatusFromAmounts(o.totalAmount, o.outstandingAmount, o.status);
        if (newStatus !== o.status && o.status !== ObligationStatus.CANCELLED) {
            diffs.push({
                entity: 'obligation',
                id: o.id,
                field: 'status',
                oldValue: o.status,
                newValue: newStatus,
            });
            if (!dryRun) {
                await prisma.cashbookObligation.update({
                    where: { id: o.id },
                    data: { status: newStatus as ObligationStatus },
                });
            }
        }
    }

    // ── Invoices from invoice-linked obligations ───────
    const invoiceObligations = obligations.filter((o) => o.referenceType === 'INVOICE' && o.referenceId);
    console.log(`Invoice-linked obligations: ${invoiceObligations.length}`);

    for (const o of invoiceObligations) {
        const invoice = await prisma.invoice.findUnique({ where: { id: o.referenceId! } });
        if (!invoice || invoice.status === InvoiceStatus.VOID || invoice.status === InvoiceStatus.DRAFT) {
            continue;
        }

        const amountPaid = invoice.totalAmount.sub(o.outstandingAmount);
        const amountDue = o.outstandingAmount.lessThan(0) ? o.outstandingAmount.mul(0) : o.outstandingAmount;
        const newStatus = invoiceStatusFromOutstanding(
            invoice.totalAmount,
            amountDue,
            invoice.status,
        ) as InvoiceStatus;

        if (
            !invoice.amountPaid.equals(amountPaid) ||
            !invoice.amountDue.equals(amountDue) ||
            invoice.status !== newStatus
        ) {
            diffs.push({
                entity: 'invoice',
                id: invoice.id,
                field: 'paid/due/status',
                oldValue: `${invoice.amountPaid}/${invoice.amountDue}/${invoice.status}`,
                newValue: `${amountPaid}/${amountDue}/${newStatus}`,
            });
            if (!dryRun) {
                await prisma.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        amountPaid: amountPaid.lessThan(0) ? invoice.totalAmount : amountPaid,
                        amountDue,
                        status: newStatus,
                    },
                });
            }
        }
    }

    console.log(`\nDiffs found: ${diffs.length}`);
    for (const d of diffs.slice(0, 200)) {
        console.log(`  [${d.entity}] ${d.id} ${d.field}: ${d.oldValue} → ${d.newValue}`);
    }
    if (diffs.length > 200) {
        console.log(`  ... and ${diffs.length - 200} more`);
    }

    if (dryRun) {
        console.log('\nRe-run with --apply to write corrections.');
    } else {
        console.log('\nCorrections applied. Re-run dry-run to confirm zero remaining diffs.');
    }
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
