/**
 * A ticket sale is a cashbook entry.
 *
 * That is the whole design claim of this module, and it is what these tests
 * exist to hold. A sale must move the wallet, count as income in the gate book,
 * and leave the trial balance at zero — because it goes through exactly the same
 * posting path a hand-typed entry does, rather than a parallel one that happens
 * to write similar-looking rows.
 *
 * The interesting case is the comped sale: three tickets, no money. It must
 * issue the tickets and post NOTHING, because there is no money to record and a
 * zero-amount entry is not a thing the ledger can hold.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import {
    buildGate, ticketing, trialBalance, walletBalance, cashbookTotals,
} from './fixture';

describe('a ticket sale posts to the books', () => {
    beforeEach(resetDatabase);

    it('moves the wallet, counts as income, and leaves the books balanced', async () => {
        const gate = await buildGate();

        const sale = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [
                { ticketTypeId: gate.adultTypeId, quantity: 1 },
                { ticketTypeId: gate.minorTypeId, quantity: 2 },
            ],
            accountId: gate.wallet.id,
        } as any);

        expect(sale.netAmount.toString()).toBe('40000');
        expect(sale.ticketCount).toBe(3);
        expect(sale.entryId).not.toBeNull();

        expect(await walletBalance(gate.wallet.id)).toBe('40000');

        const totals = await cashbookTotals(gate.cashbookId);
        expect(totals.totalIncome).toBe('40000');
        // Wallet-linked entries do not move book cash — the rule the whole
        // wallet model rests on. Ticketing must not be an exception to it.
        expect(totals.balance).toBe('0');

        expect(await trialBalance()).toBe('0');
    });

    it('writes one entry per sale, linked both ways', async () => {
        const gate = await buildGate();

        const sale = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: gate.wallet.id,
        } as any);

        const entry = await testPrisma.entry.findUniqueOrThrow({
            where: { id: sale.entryId! },
        });
        expect(entry.type).toBe('INCOME');
        expect(entry.amount.toString()).toBe('20000');
        expect(entry.cashbookId).toBe(gate.cashbookId);
        expect(entry.status).toBe('POSTED');

        // The description has to be readable by whoever opens the book later.
        expect(entry.description).toContain('Tonight');
        expect(entry.description).toContain('Adult');

        const back = await testPrisma.ticketSale.findUniqueOrThrow({
            where: { entryId: entry.id },
        });
        expect(back.id).toBe(sale.id);
    });

    it('issues one ticket per head, with a serial and a snapshot price', async () => {
        const gate = await buildGate();

        const sale = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.minorTypeId, quantity: 3 }],
            accountId: gate.wallet.id,
        } as any);

        const tickets = await testPrisma.ticket.findMany({
            where: { saleId: sale.id },
            orderBy: { serialNo: 'asc' },
        });

        expect(tickets).toHaveLength(3);
        expect(tickets.map((t: { serialNo: string }) => t.serialNo)).toEqual([
            expect.stringMatching(/^TKT-\d{8}-0001$/),
            expect.stringMatching(/^TKT-\d{8}-0002$/),
            expect.stringMatching(/^TKT-\d{8}-0003$/),
        ]);
        expect(tickets.every((t: { netPrice: { toString(): string } }) => t.netPrice.toString() === '10000')).toBe(true);
        expect(tickets.every((t: { status: string }) => t.status === 'ISSUED')).toBe(true);
    });

    it('keeps serials unique and increasing across sales on the same night', async () => {
        const gate = await buildGate();

        await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 2 }],
            accountId: gate.wallet.id,
        } as any);
        await ticketing().createSale(gate.workspace.id, gate.otherAttendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 2 }],
            accountId: gate.wallet.id,
        } as any);

        const serials = (await testPrisma.ticket.findMany({
            where: { workspaceId: gate.workspace.id },
            orderBy: { serialNo: 'asc' },
            select: { serialNo: true },
        })).map((t: { serialNo: string }) => t.serialNo);

        expect(new Set(serials).size).toBe(4);
        expect(serials[3]).toMatch(/0004$/);
    });

    it('opens the night on the first sale, without anybody opening it by hand', async () => {
        const gate = await buildGate();

        expect(await testPrisma.ticketDay.count()).toBe(0);

        await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: gate.wallet.id,
        } as any);

        const day = await testPrisma.ticketDay.findFirstOrThrow();
        expect(day.status).toBe('OPEN');
        expect(day.sessionId).toBe(gate.sessionId);
    });
});

describe('discounts', () => {
    beforeEach(resetDatabase);

    it('posts the net, and records the gross and the give-away on the tickets', async () => {
        const gate = await buildGate({ guardianComp: true });

        const sale = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [
                { ticketTypeId: gate.adultTypeId, quantity: 1 },
                { ticketTypeId: gate.minorTypeId, quantity: 2 },
            ],
            accountId: gate.wallet.id,
        } as any);

        expect(sale.grossAmount.toString()).toBe('40000');
        expect(sale.discountAmount.toString()).toBe('20000');
        expect(sale.netAmount.toString()).toBe('20000');

        // The books see cash received, not list price.
        const entry = await testPrisma.entry.findUniqueOrThrow({ where: { id: sale.entryId! } });
        expect(entry.amount.toString()).toBe('20000');
        expect(await walletBalance(gate.wallet.id)).toBe('20000');

        // The give-away is still reportable, per head, with the rule that did it.
        const free = await testPrisma.ticket.findFirstOrThrow({
            where: { saleId: sale.id, netPrice: 0 },
            include: { appliedRule: true },
        });
        expect(free.patronClass).toBe('ADULT');
        expect(free.grossPrice.toString()).toBe('20000');
        expect(free.appliedRule?.name).toBe('Guardian goes free');

        expect(await trialBalance()).toBe('0');
    });

    it('issues tickets and posts no entry when the whole sale is comped', async () => {
        const gate = await buildGate({ guardianComp: true, adultPrice: '20000', minorPrice: '0' });

        const sale = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [
                { ticketTypeId: gate.adultTypeId, quantity: 1 },
                { ticketTypeId: gate.minorTypeId, quantity: 2 },
            ],
            accountId: gate.wallet.id,
        } as any);

        expect(sale.netAmount.toString()).toBe('0');
        expect(sale.ticketCount).toBe(3);

        // No money moved, so nothing was recorded as having moved.
        expect(sale.entryId).toBeNull();
        expect(await testPrisma.entry.count()).toBe(0);
        expect(await walletBalance(gate.wallet.id)).toBe('0');

        // But three people still came through the gate.
        expect(await testPrisma.ticket.count({ where: { saleId: sale.id } })).toBe(3);
        expect(await trialBalance()).toBe('0');
    });
});

describe('what the desk refuses', () => {
    beforeEach(resetDatabase);

    it('refuses a wallet from another workspace', async () => {
        const gate = await buildGate();
        const stranger = await buildGate();

        await expect(ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: stranger.wallet.id,
        } as any)).rejects.toMatchObject({ code: 'INVALID_ACCOUNT' });
    });

    it('refuses to sell before anyone has set up a book to post into', async () => {
        const gate = await buildGate();
        await testPrisma.ticketSettings.update({
            where: { workspaceId: gate.workspace.id },
            data: { isConfigured: false, cashbookId: null },
        });

        await expect(ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: gate.wallet.id,
        } as any)).rejects.toMatchObject({ code: 'TICKETING_NOT_CONFIGURED' });
    });

    it('refuses when no session is configured for tonight', async () => {
        // A session for a different weekday, so today resolves to nothing.
        const gate = await buildGate({ dayOfWeek: (new Date().getDay() + 3) % 7 });

        await expect(ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: gate.wallet.id,
        } as any)).rejects.toMatchObject({ code: 'NO_SESSION_TODAY' });
    });

    it('refuses a hand-applied discount from someone who cannot manage ticketing', async () => {
        const gate = await buildGate();
        const rule = await testPrisma.ticketDiscountRule.create({
            data: {
                workspaceId: gate.workspace.id,
                name: 'Manager discretion',
                type: 'MANUAL',
                valueType: 'PERCENT',
                value: 50,
                config: {},
                priority: 5,
            },
        });

        await expect(ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: gate.wallet.id,
            manualRuleIds: [rule.id],
        } as any)).rejects.toThrow(/manager/i);
    });

    it('lets a manager apply that same discount', async () => {
        const gate = await buildGate();
        const rule = await testPrisma.ticketDiscountRule.create({
            data: {
                workspaceId: gate.workspace.id,
                name: 'Manager discretion',
                type: 'MANUAL',
                valueType: 'PERCENT',
                value: 50,
                config: {},
                priority: 5,
            },
        });

        const sale = await ticketing().createSale(gate.workspace.id, gate.ownerActor, {
            lines: [{ ticketTypeId: gate.adultTypeId, quantity: 1 }],
            accountId: gate.wallet.id,
            manualRuleIds: [rule.id],
        } as any);

        expect(sale.netAmount.toString()).toBe('10000');
        expect(await trialBalance()).toBe('0');
    });
});
