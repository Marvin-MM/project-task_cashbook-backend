/**
 * The loyalty programme, end to end.
 *
 * Two claims under test. That a card actually changes what somebody is charged,
 * and that the per-day cap holds ACROSS sales rather than within one basket —
 * the latter being the difference between a member discount and a way to admit a
 * coach party at 20% off, one ticket at a time.
 *
 * Plus the accounting one: a joining fee is revenue, and must reach the books
 * through the same path a ticket sale does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import {
    buildGate, ticketing, ticketConfig, memberships, trialBalance, walletBalance,
} from './fixture';

async function goldTier(gate: any, over: Record<string, unknown> = {}) {
    return memberships().createTier(gate.workspace.id, gate.owner.id, {
        name: 'Gold',
        discountValueType: 'PERCENT',
        discountValue: '20',
        appliesToTicketTypeIds: [gate.adultTypeId],
        ...over,
    } as any);
}

async function issue(gate: any, tierId: string, over: Record<string, unknown> = {}) {
    return memberships().create(gate.workspace.id, gate.owner.id, {
        tierId, name: 'Jane Okello', phone: '+256700000001', ...over,
    } as any);
}

const sellAdults = (gate: any, quantity: number, memberNo?: string) =>
    ticketing().createSale(gate.workspace.id, gate.attendantActor, {
        lines: [{ ticketTypeId: gate.adultTypeId, quantity }],
        accountId: gate.wallet.id,
        memberNo,
    } as any);

describe('issuing a card', () => {
    beforeEach(resetDatabase);

    it('generates a member number and attaches it to a customer record', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);

        const membership = await issue(gate, tier.id);

        expect(membership.memberNo).toBe('M-00001');
        expect(membership.status).toBe('ACTIVE');
        expect(membership.contact.name).toBe('Jane Okello');

        // Layered on a real contact, so the same person's receipts and invoices
        // land on one record.
        const contact = await testPrisma.contact.findUniqueOrThrow({
            where: { id: membership.contactId },
        });
        expect(contact.type).toBe('CUSTOMER');
    });

    it('counts up from the highest number, not from a row count', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);

        await issue(gate, tier.id);
        const second = await issue(gate, tier.id, { name: 'Peter M', phone: '+256700000002' });
        expect(second.memberNo).toBe('M-00002');

        // Cancelling a card keeps its number reserved. Counting rows instead of
        // reading the highest would hand M-00002 to the next member while a
        // physical card carrying it is still in somebody's wallet.
        await memberships().update(gate.workspace.id, second.id, gate.owner.id, {
            status: 'CANCELLED',
        } as any);

        const third = await issue(gate, tier.id, { name: 'Sara N', phone: '+256700000003' });
        expect(third.memberNo).toBe('M-00003');
    });

    it('keeps a pre-printed number out of the generated sequence', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);

        await issue(gate, tier.id, { memberNo: 'CARD-0500' });
        const generated = await issue(gate, tier.id, { name: 'Peter M', phone: '+256700000002' });
        expect(generated.memberNo).toBe('M-00001');
    });

    it('reuses an existing customer rather than duplicating them', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);

        const existing = await testPrisma.contact.create({
            data: {
                workspaceId: gate.workspace.id, type: 'CUSTOMER',
                name: 'Jane Okello', phone: '+256700000001',
            },
        });

        const membership = await issue(gate, tier.id);
        expect(membership.contactId).toBe(existing.id);
        expect(await testPrisma.contact.count({ where: { workspaceId: gate.workspace.id } })).toBe(1);
    });

    it('accepts a pre-printed card number', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id, { memberNo: 'CARD-0042' });
        expect(membership.memberNo).toBe('CARD-0042');
    });

    it('sets an expiry from the tier’s validity', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { validityMonths: 12 });
        const membership = await issue(gate, tier.id);

        expect(membership.validUntil).not.toBeNull();
        const months = (membership.validUntil!.getFullYear() - membership.validFrom.getFullYear()) * 12
            + (membership.validUntil!.getMonth() - membership.validFrom.getMonth());
        expect(months).toBe(12);
    });
});

describe('a joining fee is revenue', () => {
    beforeEach(resetDatabase);

    it('posts an income entry for the fee, through the ordinary entry path', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { price: '100000', validityMonths: 12 });

        const membership = await issue(gate, tier.id, { accountId: gate.wallet.id });

        expect(await walletBalance(gate.wallet.id)).toBe('100000');

        const full = await testPrisma.membership.findUniqueOrThrow({
            where: { id: membership.id },
        });
        expect(full.entryId).not.toBeNull();

        const entry = await testPrisma.entry.findUniqueOrThrow({ where: { id: full.entryId! } });
        expect(entry.type).toBe('INCOME');
        expect(entry.amount.toString()).toBe('100000');
        expect(entry.description).toContain('Membership');
        expect(entry.contactId).toBe(membership.contactId);

        expect(await trialBalance()).toBe('0');
    });

    it('refuses to issue a paid membership without saying where the money went', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { price: '100000' });

        await expect(issue(gate, tier.id)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' });
        expect(await testPrisma.membership.count()).toBe(0);
    });

    it('posts nothing for a free tier', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        await issue(gate, tier.id);
        expect(await testPrisma.entry.count()).toBe(0);
    });

    it('extends from the current expiry when renewing early', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { validityMonths: 12 });
        const membership = await issue(gate, tier.id);
        const before = membership.validUntil!;

        const renewed = await memberships().renew(
            gate.workspace.id, membership.id, gate.owner.id, {} as any,
        );

        // Renewing early must not throw away the time already paid for.
        const months = (renewed.validUntil!.getFullYear() - before.getFullYear()) * 12
            + (renewed.validUntil!.getMonth() - before.getMonth());
        expect(months).toBe(12);
    });
});

describe('what a card is worth at the gate', () => {
    beforeEach(resetDatabase);

    it('discounts the tiers the card covers', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id);

        const sale = await sellAdults(gate, 1, membership.memberNo);

        expect(sale.grossAmount.toString()).toBe('20000');
        expect(sale.discountAmount.toString()).toBe('4000');
        expect(sale.netAmount.toString()).toBe('16000');
        expect(sale.membershipId).toBe(membership.id);
        expect(await walletBalance(gate.wallet.id)).toBe('16000');
        expect(await trialBalance()).toBe('0');
    });

    it('sells at list price when the number is unknown, rather than blocking the queue', async () => {
        const gate = await buildGate();
        await goldTier(gate);

        const sale = await sellAdults(gate, 1, 'M-99999');
        expect(sale.discountAmount.toString()).toBe('0');
        expect(sale.membershipId).toBeNull();
    });

    it('ignores an expired card', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { validityMonths: 12 });
        const membership = await issue(gate, tier.id);

        // Both bounds move: the database asserts validUntil > validFrom, so a
        // card cannot be made to have expired before it was issued.
        await testPrisma.membership.update({
            where: { id: membership.id },
            data: { validFrom: new Date('2019-01-01'), validUntil: new Date('2020-01-01') },
        });

        const sale = await sellAdults(gate, 1, membership.memberNo);
        expect(sale.discountAmount.toString()).toBe('0');
    });

    it('ignores a suspended card', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id);
        await testPrisma.membership.update({
            where: { id: membership.id }, data: { status: 'SUSPENDED' },
        });

        const sale = await sellAdults(gate, 1, membership.memberNo);
        expect(sale.discountAmount.toString()).toBe('0');
    });

    it('holds the daily cap ACROSS sales, not just within one basket', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { maxUsesPerDay: 2 });
        const membership = await issue(gate, tier.id);

        const first = await sellAdults(gate, 1, membership.memberNo);
        expect(first.discountAmount.toString()).toBe('4000');

        const second = await sellAdults(gate, 1, membership.memberNo);
        expect(second.discountAmount.toString()).toBe('4000');

        // Allowance spent. Without cross-sale counting, this would discount
        // forever one ticket at a time.
        const third = await sellAdults(gate, 1, membership.memberNo);
        expect(third.discountAmount.toString()).toBe('0');
    });

    it('gives the allowance back when a sale is reversed', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { maxUsesPerDay: 1 });
        const membership = await issue(gate, tier.id);

        const first = await sellAdults(gate, 1, membership.memberNo);
        expect(first.discountAmount.toString()).toBe('4000');

        await ticketing().voidSale(
            gate.workspace.id, first.id, gate.attendantActor, { reason: 'Mis-tap' },
        );

        // The redemption did not happen, so the allowance is unspent.
        const second = await sellAdults(gate, 1, membership.memberNo);
        expect(second.discountAmount.toString()).toBe('4000');
    });

    it('records the redemption, so the card’s value is reportable', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id);

        await sellAdults(gate, 2, membership.memberNo);

        const usage = await memberships().getUsage(gate.workspace.id, membership.id);
        expect(usage.totals.redemptions).toBe(1);
        expect(usage.totals.ticketsDiscounted).toBe(2);
        expect(usage.totals.totalSaved).toBe('8000.0000');
    });
});

describe('the desk lookup', () => {
    beforeEach(resetDatabase);

    it('says why a card is no good, rather than just failing to find it', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate, { validityMonths: 12 });
        const membership = await issue(gate, tier.id);
        await testPrisma.membership.update({
            where: { id: membership.id },
            data: { validFrom: new Date('2019-01-01'), validUntil: new Date('2020-01-01') },
        });

        const result = await memberships().lookup(gate.workspace.id, membership.memberNo);
        expect(result.found).toBe(true);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('EXPIRED');
    });

    it('reports an unknown number without throwing', async () => {
        const gate = await buildGate();
        const result = await memberships().lookup(gate.workspace.id, 'NOPE');
        expect(result).toMatchObject({ found: false, valid: false, reason: 'NOT_FOUND' });
    });

    it('confirms a good card and the tier it carries', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id);

        const result = await memberships().lookup(gate.workspace.id, membership.memberNo);
        expect(result.valid).toBe(true);
        expect(result.membership?.tier.name).toBe('Gold');
    });
});

describe('tiers and their offers stay in step', () => {
    beforeEach(resetDatabase);

    it('creates the matching offer, so a new tier discounts without extra setup', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);

        const rule = await testPrisma.ticketDiscountRule.findFirstOrThrow({
            where: { membershipTierId: tier.id },
        });
        expect(rule.type).toBe('MEMBERSHIP');
        expect(rule.value.toString()).toBe('20');
    });

    it('updates the offer when the tier’s discount changes', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id);

        await memberships().updateTier(gate.workspace.id, tier.id, gate.owner.id, {
            discountValue: '50',
        } as any);

        // Editing the tier alone would leave the desk still giving 20%.
        const sale = await sellAdults(gate, 1, membership.memberNo);
        expect(sale.discountAmount.toString()).toBe('10000');
    });

    it('stops discounting when the tier is deactivated', async () => {
        const gate = await buildGate();
        const tier = await goldTier(gate);
        const membership = await issue(gate, tier.id);

        await memberships().updateTier(gate.workspace.id, tier.id, gate.owner.id, {
            isActive: false,
        } as any);

        const sale = await sellAdults(gate, 1, membership.memberNo);
        expect(sale.discountAmount.toString()).toBe('0');
    });
});

describe('price changes do not rewrite history', () => {
    beforeEach(resetDatabase);

    it('leaves an already-rung sale at the price it was rung at', async () => {
        const gate = await buildGate();
        const sale = await sellAdults(gate, 1);
        expect(sale.netAmount.toString()).toBe('20000');

        await ticketConfig().updateTicketType(
            gate.workspace.id, gate.adultTypeId, gate.owner.id, { price: '35000' } as any,
        );

        const unchanged = await testPrisma.ticketSale.findUniqueOrThrow({ where: { id: sale.id } });
        expect(unchanged.netAmount.toString()).toBe('20000');

        const ticket = await testPrisma.ticket.findFirstOrThrow({ where: { saleId: sale.id } });
        expect(ticket.grossPrice.toString()).toBe('20000');

        // And the next sale gets the new price.
        const next = await sellAdults(gate, 1);
        expect(next.netAmount.toString()).toBe('35000');
    });
});
