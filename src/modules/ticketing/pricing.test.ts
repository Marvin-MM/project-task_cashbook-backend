/**
 * The offer rules, exercised at their boundaries.
 *
 * Pure unit tests — no database, no container. The cases that matter here are
 * the ones a manual check at the desk would never catch: "more than one minor"
 * being two rather than one, a member's daily cap spanning sales, and the
 * invariant the database asserts (net = gross - discount at every level).
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import {
    quoteSale,
    TicketTypeSnapshot,
    DiscountRuleSnapshot,
    MembershipSnapshot,
} from './pricing';

const d = (v: string | number) => new Decimal(v);

const ADULT: TicketTypeSnapshot = {
    id: 'type-adult', name: 'Adult', patronClass: 'ADULT', price: d(20000),
};
const MINOR: TicketTypeSnapshot = {
    id: 'type-minor', name: 'Minor', patronClass: 'MINOR', price: d(10000),
};
const VIP: TicketTypeSnapshot = {
    id: 'type-vip', name: 'VIP', patronClass: 'ADULT', price: d(50000),
};

const TYPES = [ADULT, MINOR, VIP];

const guardianComp = (over: Partial<DiscountRuleSnapshot> = {}): DiscountRuleSnapshot => ({
    id: 'rule-guardian',
    name: 'Guardian goes free',
    type: 'GUARDIAN_COMP',
    valueType: 'PERCENT',
    value: d(100),
    config: { minMinors: 2, compPatronClass: 'ADULT', maxCompPerSale: 1 },
    membershipTierId: null,
    priority: 10,
    stackable: false,
    ...over,
});

const memberOffer = (over: Partial<DiscountRuleSnapshot> = {}): DiscountRuleSnapshot => ({
    id: 'rule-gold',
    name: 'Gold: 20% off adults',
    type: 'MEMBERSHIP',
    valueType: 'PERCENT',
    value: d(20),
    config: { ticketTypeIds: [ADULT.id] },
    membershipTierId: 'tier-gold',
    priority: 20,
    stackable: false,
    ...over,
});

const gold = (over: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({
    id: 'mem-1', tierId: 'tier-gold', maxUsesPerDay: null, usedToday: 0, ...over,
});

const quote = (
    lines: { ticketTypeId: string; quantity: number }[],
    rules: DiscountRuleSnapshot[] = [],
    membership: MembershipSnapshot | null = null,
    manualRuleIds?: string[],
) => quoteSale({ types: TYPES, lines, rules, membership, manualRuleIds });

/** The invariant the DB CHECK constraints assert, at all three levels. */
function expectArithmeticHolds(q: ReturnType<typeof quote>) {
    for (const t of q.tickets) {
        expect(t.netPrice.toString()).toBe(t.grossPrice.sub(t.discountAmount).toString());
        expect(t.netPrice.isNegative()).toBe(false);
        expect(t.discountAmount.isNegative()).toBe(false);
    }
    for (const l of q.lines) {
        expect(l.lineNet.toString()).toBe(l.lineGross.sub(l.lineDiscount).toString());
    }
    expect(q.netAmount.toString()).toBe(q.grossAmount.sub(q.discountAmount).toString());

    const ticketGross = q.tickets.reduce((a, t) => a.add(t.grossPrice), d(0));
    const ticketNet = q.tickets.reduce((a, t) => a.add(t.netPrice), d(0));
    expect(q.grossAmount.toString()).toBe(ticketGross.toString());
    expect(q.netAmount.toString()).toBe(ticketNet.toString());
}

describe('quoteSale — no offers', () => {
    it('charges list price and issues one ticket per head', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 1 },
            { ticketTypeId: MINOR.id, quantity: 2 },
        ]);

        expect(q.ticketCount).toBe(3);
        expect(q.grossAmount.toString()).toBe('40000');
        expect(q.discountAmount.toString()).toBe('0');
        expect(q.netAmount.toString()).toBe('40000');
        expect(q.tickets.every((t) => t.appliedRuleId === null)).toBe(true);
        expectArithmeticHolds(q);
    });

    it('rejects a ticket type that is not on the session', () => {
        expect(() => quote([{ ticketTypeId: 'type-ghost', quantity: 1 }]))
            .toThrow(/Unknown ticket type/);
    });
});

describe('quoteSale — guardian comp', () => {
    it('comps the adult when two minors come along', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 1 },
            { ticketTypeId: MINOR.id, quantity: 2 },
        ], [guardianComp()]);

        // Three tickets still issued; one of them is free.
        expect(q.ticketCount).toBe(3);
        expect(q.grossAmount.toString()).toBe('40000');
        expect(q.discountAmount.toString()).toBe('20000');
        expect(q.netAmount.toString()).toBe('20000');

        const free = q.tickets.filter((t) => t.netPrice.isZero());
        expect(free).toHaveLength(1);
        expect(free[0]!.patronClass).toBe('ADULT');
        expect(free[0]!.appliedRuleId).toBe('rule-guardian');
        expectArithmeticHolds(q);
    });

    it('does NOT comp with only one minor — "more than one" means two', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 1 },
            { ticketTypeId: MINOR.id, quantity: 1 },
        ], [guardianComp()]);

        expect(q.discountAmount.toString()).toBe('0');
        expect(q.netAmount.toString()).toBe('30000');
        expectArithmeticHolds(q);
    });

    it('comps only one adult by default, however many minors turn up', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 2 },
            { ticketTypeId: MINOR.id, quantity: 4 },
        ], [guardianComp()]);

        expect(q.discountAmount.toString()).toBe('20000');
        expect(q.tickets.filter((t) => t.netPrice.isZero())).toHaveLength(1);
        expectArithmeticHolds(q);
    });

    it('honours maxCompPerSale above one', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 2 },
            { ticketTypeId: MINOR.id, quantity: 4 },
        ], [guardianComp({ config: { minMinors: 2, compPatronClass: 'ADULT', maxCompPerSale: 2 } })]);

        expect(q.discountAmount.toString()).toBe('40000');
        expect(q.tickets.filter((t) => t.netPrice.isZero())).toHaveLength(2);
    });

    it('frees the dearest eligible adult, not the first one entered', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 1 },
            { ticketTypeId: VIP.id, quantity: 1 },
            { ticketTypeId: MINOR.id, quantity: 2 },
        ], [guardianComp()]);

        const free = q.tickets.find((t) => t.netPrice.isZero());
        expect(free?.ticketTypeId).toBe(VIP.id);
        expect(q.discountAmount.toString()).toBe('50000');
        expectArithmeticHolds(q);
    });

    it('does nothing when there is no adult to comp', () => {
        const q = quote([{ ticketTypeId: MINOR.id, quantity: 3 }], [guardianComp()]);
        expect(q.discountAmount.toString()).toBe('0');
    });
});

describe('quoteSale — membership offers', () => {
    it('applies the tier discount to the tiers it names', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 1 },
            { ticketTypeId: MINOR.id, quantity: 1 },
        ], [memberOffer()], gold());

        expect(q.discountAmount.toString()).toBe('4000');   // 20% of the adult only
        expect(q.netAmount.toString()).toBe('26000');
        expect(q.membershipDiscount.toString()).toBe('4000');
        expect(q.membershipTicketCount).toBe(1);
        expectArithmeticHolds(q);
    });

    it('is inert without a card', () => {
        const q = quote([{ ticketTypeId: ADULT.id, quantity: 1 }], [memberOffer()], null);
        expect(q.discountAmount.toString()).toBe('0');
        expect(q.membershipTicketCount).toBe(0);
    });

    it('is inert for a card on a different tier', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 1 }],
            [memberOffer()],
            gold({ tierId: 'tier-silver' }),
        );
        expect(q.discountAmount.toString()).toBe('0');
    });

    it('stops at the daily cap, counting uses from earlier sales', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 3 }],
            [memberOffer()],
            gold({ maxUsesPerDay: 2, usedToday: 1 }),
        );

        // One use left today, so exactly one head is discounted.
        expect(q.membershipTicketCount).toBe(1);
        expect(q.discountAmount.toString()).toBe('4000');
        expectArithmeticHolds(q);
    });

    it('gives nothing once the cap is spent', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 2 }],
            [memberOffer()],
            gold({ maxUsesPerDay: 2, usedToday: 2 }),
        );
        expect(q.discountAmount.toString()).toBe('0');
        expect(q.membershipTicketCount).toBe(0);
    });

    it('covers every ticket when the tier names none', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 1 }, { ticketTypeId: MINOR.id, quantity: 1 }],
            [memberOffer({ config: {} })],
            gold(),
        );
        expect(q.discountAmount.toString()).toBe('6000');   // 20% of 20000 + 20% of 10000
        expect(q.membershipTicketCount).toBe(2);
    });
});

describe('quoteSale — precedence and stacking', () => {
    it('applies the lower priority number first, and does not compound by default', () => {
        const q = quote([
            { ticketTypeId: ADULT.id, quantity: 1 },
            { ticketTypeId: MINOR.id, quantity: 2 },
        ], [guardianComp(), memberOffer()], gold());

        // The guardian comp (priority 10) takes the adult to zero. The member
        // offer (priority 20) is not stackable, so it finds nothing left to
        // discount — the adult is spoken for and minors are not in its list.
        expect(q.discountAmount.toString()).toBe('20000');
        expect(q.netAmount.toString()).toBe('20000');
        expectArithmeticHolds(q);
    });

    it('lets a stackable rule add on top of one that already fired', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 1 }],
            [
                memberOffer({ id: 'rule-a', priority: 10, value: d(10), membershipTierId: null }),
                memberOffer({ id: 'rule-b', priority: 20, value: d(10), membershipTierId: null, stackable: true }),
            ],
            gold(),
        );

        // Both are 10% OF GROSS, so 2000 + 2000 rather than a compounding 3800.
        expect(q.discountAmount.toString()).toBe('4000');
        expect(q.netAmount.toString()).toBe('16000');
        expectArithmeticHolds(q);
    });

    it('never lets stacked offers push a ticket below zero', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 1 }],
            [
                memberOffer({ id: 'rule-a', priority: 10, value: d(80), membershipTierId: null }),
                memberOffer({ id: 'rule-b', priority: 20, value: d(80), membershipTierId: null, stackable: true }),
            ],
            gold(),
        );

        expect(q.netAmount.toString()).toBe('0');
        expect(q.discountAmount.toString()).toBe('20000');
        expectArithmeticHolds(q);
    });

    it('caps a flat AMOUNT larger than the ticket at the ticket price', () => {
        const q = quote(
            [{ ticketTypeId: MINOR.id, quantity: 1 }],
            [memberOffer({ valueType: 'AMOUNT', value: d(999999), config: {} })],
            gold(),
        );
        expect(q.netAmount.toString()).toBe('0');
        expect(q.discountAmount.toString()).toBe('10000');
        expectArithmeticHolds(q);
    });

    it('orders deterministically when two rules share a priority', () => {
        const rules = [
            memberOffer({ id: 'rule-b', priority: 10, value: d(50), membershipTierId: null }),
            memberOffer({ id: 'rule-a', priority: 10, value: d(10), membershipTierId: null }),
        ];
        const first = quote([{ ticketTypeId: ADULT.id, quantity: 1 }], rules, gold());
        const second = quote([{ ticketTypeId: ADULT.id, quantity: 1 }], [...rules].reverse(), gold());

        // rule-a wins the tie by id, both times.
        expect(first.discountAmount.toString()).toBe('2000');
        expect(second.discountAmount.toString()).toBe(first.discountAmount.toString());
    });
});

describe('quoteSale — group and manual offers', () => {
    it('applies a group offer only once the minimum is met', () => {
        const rule = memberOffer({
            id: 'rule-group', type: 'GROUP', value: d(10),
            config: { minQuantity: 4, ticketTypeIds: [MINOR.id] }, membershipTierId: null,
        });

        const under = quote([{ ticketTypeId: MINOR.id, quantity: 3 }], [rule]);
        expect(under.discountAmount.toString()).toBe('0');

        const over = quote([{ ticketTypeId: MINOR.id, quantity: 4 }], [rule]);
        expect(over.discountAmount.toString()).toBe('4000');   // 10% off four 10,000s
        expectArithmeticHolds(over);
    });

    it('ignores a MANUAL rule nobody asked for', () => {
        const rule = memberOffer({
            id: 'rule-manual', type: 'MANUAL', value: d(50), config: {}, membershipTierId: null,
        });
        expect(quote([{ ticketTypeId: ADULT.id, quantity: 1 }], [rule]).discountAmount.toString())
            .toBe('0');
    });

    it('applies a MANUAL rule when it is explicitly named', () => {
        const rule = memberOffer({
            id: 'rule-manual', type: 'MANUAL', value: d(50), config: {}, membershipTierId: null,
        });
        const q = quote([{ ticketTypeId: ADULT.id, quantity: 1 }], [rule], null, ['rule-manual']);
        expect(q.discountAmount.toString()).toBe('10000');
        expectArithmeticHolds(q);
    });
});

describe('quoteSale — rounding', () => {
    it('rounds the discount and derives the net, so the DB CHECK always holds', () => {
        const odd: TicketTypeSnapshot = {
            id: 'type-odd', name: 'Odd', patronClass: 'ADULT', price: d('10000.01'),
        };
        const q = quoteSale({
            types: [odd],
            lines: [{ ticketTypeId: odd.id, quantity: 3 }],
            rules: [memberOffer({ value: d('33.333'), config: {}, membershipTierId: null })],
            membership: gold(),
        });

        for (const t of q.tickets) {
            expect(t.discountAmount.decimalPlaces()).toBeLessThanOrEqual(4);
        }
        expectArithmeticHolds(q);
    });
});

describe('quoteSale — the all-comped basket', () => {
    it('reports a zero net while still issuing every ticket', () => {
        const q = quote(
            [{ ticketTypeId: ADULT.id, quantity: 2 }],
            [memberOffer({ value: d(100), config: {}, membershipTierId: null })],
            gold(),
        );

        expect(q.ticketCount).toBe(2);
        expect(q.netAmount.isZero()).toBe(true);
        expect(q.grossAmount.toString()).toBe('40000');
        expectArithmeticHolds(q);
    });
});
