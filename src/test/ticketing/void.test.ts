/**
 * Reversing a sale.
 *
 * Two things are under test and they are separable. First the AUTHORITY rules —
 * an attendant reaches their own mistake and nobody else's, and a closed day is
 * closed to everyone. Second the MECHANICS — a void must reverse the ledger
 * rather than delete anything, leaving the trial balance at zero and the history
 * of the correction visible.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import { buildGate, ticketing, trialBalance, walletBalance, cashbookTotals } from './fixture';

const sell = (gate: any, actor: any, quantity = 1) =>
    ticketing().createSale(gate.workspace.id, actor, {
        lines: [{ ticketTypeId: gate.adultTypeId, quantity }],
        accountId: gate.wallet.id,
    } as any);

describe('who may reverse a sale', () => {
    beforeEach(resetDatabase);

    it('lets an attendant reverse their own sale while the day is open', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);

        const voided = await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Wrong ticket type' },
        );

        expect(voided.status).toBe('VOIDED');
        expect(voided.voidReason).toBe('Wrong ticket type');
        expect(voided.voidedById).toBe(gate.attendant.id);
    });

    it("refuses to let one attendant reverse another's takings", async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);

        await expect(ticketing().voidSale(
            gate.workspace.id, sale.id, gate.otherAttendantActor, { reason: 'Not mine to reverse' },
        )).rejects.toThrow(/only reverse sales you rang up/i);

        const untouched = await testPrisma.ticketSale.findUniqueOrThrow({ where: { id: sale.id } });
        expect(untouched.status).toBe('COMPLETED');
    });

    it('lets a manager reverse anybody’s sale', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);

        const voided = await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.ownerActor, { reason: 'Customer left' },
        );
        expect(voided.status).toBe('VOIDED');
    });

    it('refuses a self-void when the workspace has turned it off', async () => {
        const gate = await buildGate();
        await testPrisma.ticketSettings.update({
            where: { workspaceId: gate.workspace.id },
            data: { allowSelfVoid: false },
        });
        const sale = await sell(gate, gate.attendantActor);

        await expect(ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Mis-tap' },
        )).rejects.toThrow(/supervisor/i);
    });

    it('refuses to reverse the same sale twice', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);
        await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Mis-tap' },
        );

        await expect(ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Again' },
        )).rejects.toMatchObject({ code: 'ALREADY_VOIDED' });
    });

    it('refuses once the day has been closed and reconciled', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);
        const day = await testPrisma.ticketDay.findFirstOrThrow();

        await ticketing().closeDay(gate.workspace.id, day.id, gate.ownerActor, {});

        await expect(ticketing().voidSale(
            gate.workspace.id, sale.id, gate.ownerActor, { reason: 'Too late' },
        )).rejects.toMatchObject({ code: 'TICKET_DAY_CLOSED' });
    });
});

describe('what reversing actually does to the books', () => {
    beforeEach(resetDatabase);

    it('takes the money back out and leaves the trial balance at zero', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor, 2);

        expect(await walletBalance(gate.wallet.id)).toBe('40000');

        await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Card declined' },
        );

        expect(await walletBalance(gate.wallet.id)).toBe('0');
        const totals = await cashbookTotals(gate.cashbookId);
        expect(totals.totalIncome).toBe('0');
        expect(await trialBalance()).toBe('0');
    });

    it('reverses the entry rather than deleting it, so the correction is itself visible', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);

        await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Wrong price' },
        );

        // The entry still exists, marked reversed and carrying the reason.
        const entry = await testPrisma.entry.findUniqueOrThrow({ where: { id: sale.entryId! } });
        expect(entry.status).toBe('REVERSED');
        expect(entry.reversalReason).toContain('Wrong price');

        // The original journal is kept and a mirror-image one appended, rather
        // than either being edited away.
        const journals = await testPrisma.journalEntry.findMany({
            where: { sourceId: entry.id },
            orderBy: { seq: 'asc' },
        });
        expect(journals).toHaveLength(2);
        expect(journals[0]!.status).toBe('REVERSED');
        expect(journals[1]!.status).toBe('REVERSING');
    });

    it('voids the tickets, so the heads stop counting as admissions', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor, 3);

        await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Group left' },
        );

        const tickets = await testPrisma.ticket.findMany({ where: { saleId: sale.id } });
        expect(tickets).toHaveLength(3);
        expect(tickets.every((t: { status: string }) => t.status === 'VOIDED')).toBe(true);
    });

    it('records who reversed what, and why', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);

        await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.ownerActor, { reason: 'Duplicate charge' },
        );

        const audit = await testPrisma.auditLog.findFirstOrThrow({
            where: { action: 'TICKET_SALE_VOIDED', resourceId: sale.id },
        });
        const details = audit.details as any;
        expect(details.reason).toBe('Duplicate charge');
        expect(details.soldById).toBe(gate.attendant.id);
        // The distinction that matters when reviewing a night: a supervisor
        // reversing somebody else's sale is a different event from a self-void.
        expect(details.voidedBySupervisor).toBe(true);
    });

    it('handles a comped sale, which has no entry to reverse', async () => {
        const gate = await buildGate({ guardianComp: true, minorPrice: '0' });

        const sale = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [
                { ticketTypeId: gate.adultTypeId, quantity: 1 },
                { ticketTypeId: gate.minorTypeId, quantity: 2 },
            ],
            accountId: gate.wallet.id,
        } as any);
        expect(sale.entryId).toBeNull();

        const voided = await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Comped in error' },
        );

        expect(voided.status).toBe('VOIDED');
        expect(await trialBalance()).toBe('0');
    });
});

describe('closing a day', () => {
    beforeEach(resetDatabase);

    it('marks the day’s entries reconciled, which is what locks them', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);
        const day = await testPrisma.ticketDay.findFirstOrThrow();

        await ticketing().closeDay(gate.workspace.id, day.id, gate.ownerActor, {
            notes: 'Counted and banked',
        });

        const entry = await testPrisma.entry.findUniqueOrThrow({ where: { id: sale.entryId! } });
        expect(entry.isReconciled).toBe(true);

        const closed = await testPrisma.ticketDay.findUniqueOrThrow({ where: { id: day.id } });
        expect(closed.status).toBe('CLOSED');
        expect(closed.closedById).toBe(gate.owner.id);
    });

    it('refuses to close while a drawer is still open', async () => {
        const gate = await buildGate();
        await ticketing().openShift(gate.workspace.id, gate.attendantActor, {
            openingFloat: '0',
        } as any);
        const day = await testPrisma.ticketDay.findFirstOrThrow();

        await expect(ticketing().closeDay(gate.workspace.id, day.id, gate.ownerActor, {}))
            .rejects.toMatchObject({ code: 'SHIFTS_STILL_OPEN' });
    });

    it('reopening unreconciles, so a correction becomes possible again', async () => {
        const gate = await buildGate();
        const sale = await sell(gate, gate.attendantActor);
        const day = await testPrisma.ticketDay.findFirstOrThrow();

        await ticketing().closeDay(gate.workspace.id, day.id, gate.ownerActor, {});
        await ticketing().reopenDay(gate.workspace.id, day.id, gate.ownerActor, {
            notes: 'Miscount found',
        });

        const entry = await testPrisma.entry.findUniqueOrThrow({ where: { id: sale.entryId! } });
        expect(entry.isReconciled).toBe(false);

        // And the sale can now be reversed, which is the point of reopening.
        const voided = await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.ownerActor, { reason: 'Miscount' },
        );
        expect(voided.status).toBe('VOIDED');
        expect(await trialBalance()).toBe('0');
    });
});
