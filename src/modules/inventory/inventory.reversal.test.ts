/**
 * Regression tests for inventory reversal idempotency.
 *
 * The compensating rows written by reverseInventoryForReference carry the same
 * referenceType/referenceId as the movements they undo. Before `isReversal` and
 * `reversesTransactionId` existed, a second reversal re-read those rows and
 * undid the undo — so editing an entry's inventory lines twice, or editing then
 * deleting, silently corrupted stock and average cost.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryReferenceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { resetDatabase, testPrisma } from '../../test/setup';
import { resolveService } from '../../test/container';
import {
    createFinancialFixture,
    createInventoryItem,
    getStock,
    isoDate,
} from '../../test/factories';
import { EntriesService } from '../entries/entries.service';

const entriesService = () => resolveService(EntriesService);

describe('inventory reversal', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('restores stock exactly once when an entry with inventory is deleted', async () => {
        const { user, workspace, cashbook } = await createFinancialFixture();
        const item = await createInventoryItem(workspace.id);
        const entries = entriesService();

        // Purchase 10 units at 50 each.
        const purchase = await entries.createEntry(cashbook.id, user.id, {
            type: 'EXPENSE',
            amount: '500',
            description: 'buy stock',
            entryDate: isoDate(),
            inventoryItems: [{ itemId: item.id, quantity: 10, unitCost: '50' }],
        } as never);

        expect((await getStock(item.id)).quantityOnHand).toBe(10);

        await entries.deleteEntry(purchase.id, user.id, 'undo purchase', 'PRIMARY_ADMIN' as never);

        expect((await getStock(item.id)).quantityOnHand).toBe(0);

        // Exactly one compensating row, pointing at the original.
        const reversals = await testPrisma.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.ENTRY,
                referenceId: purchase.id,
                isReversal: true,
            },
        });
        expect(reversals).toHaveLength(1);
        expect(reversals[0].reversesTransactionId).toBeTruthy();
    });

    it('does not double-reverse when inventory lines are edited then the entry is deleted', async () => {
        const { user, workspace, cashbook } = await createFinancialFixture();
        const item = await createInventoryItem(workspace.id);
        const entries = entriesService();

        const purchase = await entries.createEntry(cashbook.id, user.id, {
            type: 'EXPENSE',
            amount: '500',
            description: 'buy stock',
            entryDate: isoDate(),
            inventoryItems: [{ itemId: item.id, quantity: 10, unitCost: '50' }],
        } as never);

        expect((await getStock(item.id)).quantityOnHand).toBe(10);

        // Edit the lines: reverses the original 10 and applies 4.
        const edited = await entries.updateEntry(purchase.id, user.id, {
            amount: '200',
            expectedVersion: purchase.version,
            inventoryItems: [{ itemId: item.id, quantity: 4, unitCost: '50' }],
        } as never);

        expect((await getStock(item.id)).quantityOnHand).toBe(4);

        // Delete: must reverse only the surviving 4, not resurrect the first 10.
        await entries.deleteEntry(edited.id, user.id, 'undo', 'PRIMARY_ADMIN' as never);

        const finalStock = await getStock(item.id);
        expect(finalStock.quantityOnHand).toBe(0);
        expect(new Decimal(finalStock.averageCost).greaterThanOrEqualTo(0)).toBe(true);
    });

    it('excludes reversed sales from the COGS report', async () => {
        const { user, workspace, cashbook } = await createFinancialFixture();
        const item = await createInventoryItem(workspace.id);
        const entries = entriesService();

        await entries.createEntry(cashbook.id, user.id, {
            type: 'EXPENSE',
            amount: '500',
            description: 'buy stock',
            entryDate: isoDate(),
            inventoryItems: [{ itemId: item.id, quantity: 10, unitCost: '50' }],
        } as never);

        const sale = await entries.createEntry(cashbook.id, user.id, {
            type: 'INCOME',
            amount: '400',
            description: 'sell stock',
            entryDate: isoDate(),
            inventoryItems: [{ itemId: item.id, quantity: 5, sellingPrice: '80' }],
        } as never);

        const before = await testPrisma.inventoryTransaction.count({
            where: { transactionType: 'SALE', costOfGoodsSold: { not: null }, reversedBy: null },
        });
        expect(before).toBe(1);

        await entries.deleteEntry(sale.id, user.id, 'cancelled sale', 'PRIMARY_ADMIN' as never);

        // The SALE row survives for audit but must no longer count as COGS.
        const after = await testPrisma.inventoryTransaction.count({
            where: { transactionType: 'SALE', costOfGoodsSold: { not: null }, reversedBy: null },
        });
        expect(after).toBe(0);
        expect((await getStock(item.id)).quantityOnHand).toBe(10);
    });
});
