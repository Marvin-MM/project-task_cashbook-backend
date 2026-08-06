/**
 * Capacity, concurrency and the drawer count.
 *
 * The capacity race is the one worth having a test for: two attendants on two
 * phones confirming the last seat at the same moment. It is the reason the sale
 * path takes the day's row lock before counting, and without that lock both
 * would be told yes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import { buildGate, ticketing, trialBalance } from './fixture';

const sell = (gate: any, actor: any, quantity = 1, accountId?: string) =>
    ticketing().createSale(gate.workspace.id, actor, {
        lines: [{ ticketTypeId: gate.adultTypeId, quantity }],
        accountId: accountId ?? gate.wallet.id,
    } as any);

describe('capacity', () => {
    beforeEach(resetDatabase);

    it('sells right up to the cap', async () => {
        const gate = await buildGate({ capacity: 3 });
        const sale = await sell(gate, gate.attendantActor, 3);
        expect(sale.ticketCount).toBe(3);
    });

    it('refuses the sale that would go over, and says how many are left', async () => {
        const gate = await buildGate({ capacity: 3 });
        await sell(gate, gate.attendantActor, 2);

        await expect(sell(gate, gate.attendantActor, 2))
            .rejects.toMatchObject({ code: 'SOLD_OUT' });

        // Refused entirely, not partially filled.
        expect(await testPrisma.ticket.count()).toBe(2);
    });

    it('puts the seats back when a sale is reversed', async () => {
        const gate = await buildGate({ capacity: 2 });
        const sale = await sell(gate, gate.attendantActor, 2);

        await expect(sell(gate, gate.attendantActor, 1))
            .rejects.toMatchObject({ code: 'SOLD_OUT' });

        await ticketing().voidSale(
            gate.workspace.id, sale.id, gate.attendantActor, { reason: 'Group left' },
        );

        const after = await sell(gate, gate.attendantActor, 2);
        expect(after.ticketCount).toBe(2);
    });

    it('lets exactly one of two attendants win the last seat, and refuses the other cleanly', async () => {
        const gate = await buildGate({ capacity: 1 });

        const results = await Promise.allSettled([
            sell(gate, gate.attendantActor, 1),
            sell(gate, gate.otherAttendantActor, 1),
        ]);

        const sold = results.filter((r) => r.status === 'fulfilled');
        const refused = results.filter((r) => r.status === 'rejected');

        expect(sold).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(await testPrisma.ticket.count()).toBe(1);
        expect(await trialBalance()).toBe('0');

        // The loser must be told the night is full, in words an attendant can
        // repeat to the customer. Anything else means the race was lost to a
        // database error rather than resolved by the rule.
        const reason = (refused[0] as PromiseRejectedResult).reason;
        expect(reason).toMatchObject({ code: 'SOLD_OUT' });
    });

    /*
     * Two attendants ringing the FIRST sale of the night at the same instant.
     *
     * This is a different race from the one above: neither is over capacity,
     * they are racing to create the day row itself. Both must succeed. The
     * earlier implementation created that row inside the sale transaction and
     * tried to recover from the unique-constraint violation in the same
     * transaction — which Postgres will not allow, because a failed statement
     * aborts the transaction and every subsequent command returns 25P02. The
     * loser lost their sale to an internal error.
     */
    it('lets two attendants open the night simultaneously, and both sales stand', async () => {
        const gate = await buildGate();

        const results = await Promise.allSettled([
            sell(gate, gate.attendantActor, 1),
            sell(gate, gate.otherAttendantActor, 1),
        ]);

        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        expect(await testPrisma.ticketDay.count()).toBe(1);
        expect(await testPrisma.ticketSale.count()).toBe(2);
        expect(await testPrisma.ticket.count()).toBe(2);
        expect(await trialBalance()).toBe('0');
    });

    it('caps a single tier without capping the night', async () => {
        const gate = await buildGate();
        await testPrisma.ticketType.update({
            where: { id: gate.adultTypeId },
            data: { capacity: 1 },
        });

        await sell(gate, gate.attendantActor, 1);
        await expect(sell(gate, gate.attendantActor, 1))
            .rejects.toMatchObject({ code: 'SOLD_OUT' });

        // Minors are uncapped, so the night carries on.
        const minors = await ticketing().createSale(gate.workspace.id, gate.attendantActor, {
            lines: [{ ticketTypeId: gate.minorTypeId, quantity: 5 }],
            accountId: gate.wallet.id,
        } as any);
        expect(minors.ticketCount).toBe(5);
    });

    it('does not let a raised cap reopen a night that already sold out', async () => {
        const gate = await buildGate({ capacity: 2 });
        await sell(gate, gate.attendantActor, 2);

        // The manager raises the template's capacity for future nights.
        await testPrisma.ticketSession.update({
            where: { id: gate.sessionId },
            data: { capacity: 10 },
        });

        // Tonight snapshotted its cap when it opened, so tonight is still full.
        await expect(sell(gate, gate.attendantActor, 1))
            .rejects.toMatchObject({ code: 'SOLD_OUT' });
    });
});

describe('the drawer count', () => {
    beforeEach(resetDatabase);

    it('attributes a sale to the attendant’s open shift', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '50000' } as any,
        );

        const sale = await sell(gate, gate.attendantActor);
        expect(sale.shiftId).toBe(shift.id);
    });

    /*
     * `expectedByMode` is a list once a shift closes and computes its
     * breakdown, but an OPEN shift has no breakdown yet. The column used to
     * default to the JSON object `{}` rather than `[]`, which the client
     * iterates with `for...of`/`.map()` — not iterable, and it crashed the
     * "count in" dialog for every shift that had not yet been closed.
     */
    it('gives a freshly opened shift an empty ARRAY, not an object, for expectedByMode', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );

        expect(Array.isArray(shift.expectedByMode)).toBe(true);
        expect(shift.expectedByMode).toEqual([]);
    });

    it('counts expected against counted, per wallet, and records the variance', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );

        await sell(gate, gate.attendantActor, 2);                       // 40,000 cash
        await sell(gate, gate.attendantActor, 1, gate.mobileMoney.id);  // 20,000 MoMo

        const closed = await ticketing().closeShift(
            gate.workspace.id, shift.id, gate.attendantActor,
            {
                counted: [
                    { accountId: gate.wallet.id, amount: '35000' },       // 5,000 short
                    { accountId: gate.mobileMoney.id, amount: '20000' },  // exact
                ],
            } as any,
        );

        expect(closed.status).toBe('CLOSED');
        expect(closed.expectedCash!.toString()).toBe('60000');
        expect(closed.countedCash!.toString()).toBe('55000');
        expect(closed.variance!.toString()).toBe('-5000');

        // Per wallet, because a cash shortfall must not be hidden behind a
        // mobile-money surplus.
        const breakdown = closed.expectedByMode as any[];
        const cash = breakdown.find((b) => b.accountId === gate.wallet.id);
        const momo = breakdown.find((b) => b.accountId === gate.mobileMoney.id);
        expect(cash.variance).toBe('-5000.0000');
        expect(momo.variance).toBe('0.0000');
    });

    it('excludes reversed sales from what the attendant is held to', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );

        await sell(gate, gate.attendantActor, 1);
        const mistake = await sell(gate, gate.attendantActor, 1);
        await ticketing().voidSale(
            gate.workspace.id, mistake.id, gate.attendantActor, { reason: 'Mis-tap' },
        );

        const closed = await ticketing().closeShift(
            gate.workspace.id, shift.id, gate.attendantActor,
            { counted: [{ accountId: gate.wallet.id, amount: '20000' }] } as any,
        );

        expect(closed.expectedCash!.toString()).toBe('20000');
        expect(closed.variance!.toString()).toBe('0');
    });

    it('shows an uncounted wallet as short rather than dropping it', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );
        await sell(gate, gate.attendantActor, 1);

        const closed = await ticketing().closeShift(
            gate.workspace.id, shift.id, gate.attendantActor, { counted: [] } as any,
        );

        expect(closed.expectedCash!.toString()).toBe('20000');
        expect(closed.variance!.toString()).toBe('-20000');
    });

    it('refuses to let one attendant count in another’s drawer', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );

        await expect(ticketing().closeShift(
            gate.workspace.id, shift.id, gate.otherAttendantActor, { counted: [] } as any,
        )).rejects.toThrow(/supervisor/i);
    });

    it('lets a supervisor count in somebody else’s drawer', async () => {
        const gate = await buildGate();
        const shift = await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );

        const closed = await ticketing().closeShift(
            gate.workspace.id, shift.id, gate.ownerActor, { counted: [] } as any,
        );
        expect(closed.closedById).toBe(gate.owner.id);
    });

    it('refuses a second open drawer for the same attendant', async () => {
        const gate = await buildGate();
        await ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        );

        await expect(ticketing().openShift(
            gate.workspace.id, gate.attendantActor, { openingFloat: '0' } as any,
        )).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN' });
    });

    it('refuses to open a drawer for someone else without authority', async () => {
        const gate = await buildGate();

        await expect(ticketing().openShift(gate.workspace.id, gate.attendantActor, {
            openingFloat: '0', attendantId: gate.otherAttendant.id,
        } as any)).rejects.toThrow(/supervisor/i);
    });
});
