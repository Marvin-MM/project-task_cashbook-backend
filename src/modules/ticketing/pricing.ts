/**
 * What a basket of tickets costs, and why.
 *
 * Pure: no I/O, no Prisma, no clock. Everything it needs arrives as a snapshot,
 * which is what makes the offer rules exhaustively testable — the interesting
 * cases here are boundaries ("more than one minor" is two, not one) and
 * precedence, and neither is worth discovering in production.
 *
 * Modelled on core/ledger/rules/entry.rules.ts for the same reason that file is
 * pure: the arithmetic that decides what somebody is charged should be readable
 * end to end without a database in the way.
 *
 * ─── Two decisions worth knowing before reading ───
 *
 * Offers are applied PER HEAD, not per line. An adult with two minors yields
 * three tickets, one of which is free; rolling that into a line total would lose
 * which head was comped and why, and the desk would have no answer six months
 * later when somebody asks.
 *
 * Every amount is derived so that `net = gross - discount` holds EXACTLY at all
 * three levels — ticket, line and sale. The database asserts precisely that in
 * CHECK constraints, so rounding is applied to the discount and the net is then
 * subtracted rather than rounded independently. Rounding both would eventually
 * produce a sale the database refuses to store.
 */
import { Decimal } from '@prisma/client/runtime/library';

export type PatronClassValue = 'ADULT' | 'MINOR' | 'OTHER';
export type DiscountTypeValue = 'GUARDIAN_COMP' | 'MEMBERSHIP' | 'GROUP' | 'MANUAL';
export type DiscountValueTypeValue = 'PERCENT' | 'AMOUNT';

/** Matches the Decimal(20, 4) columns these values are stored in. */
const MONEY_DP = 4;

export interface TicketTypeSnapshot {
    id: string;
    name: string;
    patronClass: PatronClassValue;
    price: Decimal;
}

export interface DiscountRuleSnapshot {
    id: string;
    name: string;
    type: DiscountTypeValue;
    valueType: DiscountValueTypeValue;
    value: Decimal;
    config: Record<string, unknown>;
    membershipTierId: string | null;
    priority: number;
    stackable: boolean;
}

export interface MembershipSnapshot {
    id: string;
    tierId: string;
    /** Null = unlimited. */
    maxUsesPerDay: number | null;
    /** Tickets this card has already had discounted on this business day. */
    usedToday: number;
}

export interface SaleLineRequest {
    ticketTypeId: string;
    quantity: number;
}

export interface QuotedTicket {
    ticketTypeId: string;
    ticketTypeName: string;
    patronClass: PatronClassValue;
    grossPrice: Decimal;
    discountAmount: Decimal;
    netPrice: Decimal;
    appliedRuleId: string | null;
    appliedRuleName: string | null;
}

export interface QuotedLine {
    ticketTypeId: string;
    ticketTypeName: string;
    quantity: number;
    unitPrice: Decimal;
    lineGross: Decimal;
    lineDiscount: Decimal;
    lineNet: Decimal;
}

export interface AppliedRuleSummary {
    ruleId: string;
    ruleName: string;
    ticketCount: number;
    discountAmount: Decimal;
}

export interface SaleQuote {
    tickets: QuotedTicket[];
    lines: QuotedLine[];
    grossAmount: Decimal;
    discountAmount: Decimal;
    netAmount: Decimal;
    ticketCount: number;
    /**
     * The share of the discount the membership earned, and over how many heads.
     * Recorded on MembershipUsage, which is what enforces maxUsesPerDay next
     * time and what answers "what has this card saved you this year".
     */
    membershipDiscount: Decimal;
    membershipTicketCount: number;
    appliedRules: AppliedRuleSummary[];
}

export interface QuoteInput {
    types: TicketTypeSnapshot[];
    lines: SaleLineRequest[];
    rules: DiscountRuleSnapshot[];
    membership: MembershipSnapshot | null;
    /**
     * MANUAL rules are never applied on their own — somebody with
     * MANAGE_TICKETING has to name one. An attendant cannot discount at will.
     */
    manualRuleIds?: string[];
}

/** A head, mid-pricing. */
interface WorkingTicket {
    index: number;
    type: TicketTypeSnapshot;
    gross: Decimal;
    discount: Decimal;
    ruleId: string | null;
    ruleName: string | null;
    /** Which line it came from, so line totals can be summed back up. */
    lineIndex: number;
    fromMembership: boolean;
}

const zero = () => new Decimal(0);

const round = (value: Decimal): Decimal =>
    value.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);

const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const idList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * The discount one rule takes off one ticket, never more than what is left.
 *
 * Capping at the remaining net is what stops a stacked offer, or a flat AMOUNT
 * larger than the ticket, from producing a negative price. The DB would refuse
 * it, but refusing a sale at the gate over an offer somebody configured
 * generously is not the behaviour anyone wants.
 */
function discountFor(rule: DiscountRuleSnapshot, gross: Decimal, alreadyTaken: Decimal): Decimal {
    const remaining = gross.sub(alreadyTaken);
    if (remaining.lessThanOrEqualTo(0)) return zero();

    const raw = rule.valueType === 'PERCENT'
        ? gross.mul(rule.value).div(100)
        : rule.value;

    const capped = round(raw);
    return capped.greaterThan(remaining) ? remaining : capped;
}

/**
 * Which heads a rule is eligible to touch, best-value first.
 *
 * "Best value first" matters wherever a rule can only cover so many heads: a
 * guardian comp that admits one adult free should free the dearest adult, and a
 * member's two-ticket allowance should cover their two dearest tickets. Cheapest
 * first would be technically compliant and would feel like being short-changed.
 */
function eligibleTickets(
    rule: DiscountRuleSnapshot,
    tickets: WorkingTicket[],
    membership: MembershipSnapshot | null,
): WorkingTicket[] {
    const untouched = (t: WorkingTicket) => rule.stackable || t.ruleId === null;

    let candidates: WorkingTicket[];

    switch (rule.type) {
        case 'GUARDIAN_COMP': {
            const minMinors = num(rule.config.minMinors, 2);
            const compClass = (rule.config.compPatronClass as PatronClassValue) ?? 'ADULT';
            const maxComp = num(rule.config.maxCompPerSale, 1);

            const minorCount = tickets.filter((t) => t.type.patronClass === 'MINOR').length;
            if (minorCount < minMinors) return [];

            candidates = tickets.filter((t) => t.type.patronClass === compClass && untouched(t));
            return byValue(candidates).slice(0, Math.max(0, maxComp));
        }

        case 'MEMBERSHIP': {
            if (!membership) return [];
            if (rule.membershipTierId && rule.membershipTierId !== membership.tierId) return [];

            const only = idList(rule.config.ticketTypeIds);
            candidates = tickets.filter(
                (t) => untouched(t) && (only.length === 0 || only.includes(t.type.id)),
            );

            if (membership.maxUsesPerDay === null) return byValue(candidates);

            // The cap is per business day across every sale, not per basket —
            // otherwise one card discounts a coach party one ticket at a time.
            const remaining = membership.maxUsesPerDay - membership.usedToday;
            if (remaining <= 0) return [];
            return byValue(candidates).slice(0, remaining);
        }

        case 'GROUP': {
            const minQuantity = num(rule.config.minQuantity, 2);
            const only = idList(rule.config.ticketTypeIds);
            candidates = tickets.filter(
                (t) => only.length === 0 || only.includes(t.type.id),
            );
            if (candidates.length < minQuantity) return [];
            return byValue(candidates.filter(untouched));
        }

        case 'MANUAL': {
            const only = idList(rule.config.ticketTypeIds);
            return byValue(tickets.filter(
                (t) => untouched(t) && (only.length === 0 || only.includes(t.type.id)),
            ));
        }

        default:
            return [];
    }
}

/** Dearest first; index breaks ties so a quote is reproducible. */
function byValue(tickets: WorkingTicket[]): WorkingTicket[] {
    return [...tickets].sort((a, b) => {
        const cmp = b.gross.comparedTo(a.gross);
        return cmp !== 0 ? cmp : a.index - b.index;
    });
}

/**
 * Price a basket.
 *
 * Called twice per sale on purpose: once for the preview the attendant sees, and
 * again server-side at confirm, from database state. The client's numbers are
 * never trusted — they are a display of this function's answer, not an input to
 * it.
 */
export function quoteSale(input: QuoteInput): SaleQuote {
    const typeById = new Map(input.types.map((t) => [t.id, t]));
    const manualAllowed = new Set(input.manualRuleIds ?? []);

    // ─── Expand the basket into heads ───
    const tickets: WorkingTicket[] = [];
    input.lines.forEach((line, lineIndex) => {
        const type = typeById.get(line.ticketTypeId);
        if (!type) {
            throw new Error(`Unknown ticket type in sale: ${line.ticketTypeId}`);
        }
        for (let i = 0; i < line.quantity; i += 1) {
            tickets.push({
                index: tickets.length,
                type,
                gross: type.price,
                discount: zero(),
                ruleId: null,
                ruleName: null,
                lineIndex,
                fromMembership: false,
            });
        }
    });

    // ─── Apply the offers ───
    //
    // Lowest priority number first; id breaks ties so two rules configured at the
    // same priority still produce one deterministic answer rather than whichever
    // the database happened to return first.
    const ordered = [...input.rules]
        .filter((r) => r.type !== 'MANUAL' || manualAllowed.has(r.id))
        .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));

    const summaries = new Map<string, AppliedRuleSummary>();

    for (const rule of ordered) {
        for (const ticket of eligibleTickets(rule, tickets, input.membership)) {
            const amount = discountFor(rule, ticket.gross, ticket.discount);
            if (amount.lessThanOrEqualTo(0)) continue;

            ticket.discount = ticket.discount.add(amount);
            // The LAST rule to touch a head is the one recorded against it. With
            // stacking off — the default — there is only ever one.
            ticket.ruleId = rule.id;
            ticket.ruleName = rule.name;
            if (rule.type === 'MEMBERSHIP') ticket.fromMembership = true;

            const summary = summaries.get(rule.id) ?? {
                ruleId: rule.id,
                ruleName: rule.name,
                ticketCount: 0,
                discountAmount: zero(),
            };
            summary.ticketCount += 1;
            summary.discountAmount = summary.discountAmount.add(amount);
            summaries.set(rule.id, summary);
        }
    }

    // ─── Roll up ───
    const quotedTickets: QuotedTicket[] = tickets.map((t) => ({
        ticketTypeId: t.type.id,
        ticketTypeName: t.type.name,
        patronClass: t.type.patronClass,
        grossPrice: t.gross,
        discountAmount: t.discount,
        netPrice: t.gross.sub(t.discount),
        appliedRuleId: t.ruleId,
        appliedRuleName: t.ruleName,
    }));

    const lines: QuotedLine[] = input.lines.map((line, lineIndex) => {
        const type = typeById.get(line.ticketTypeId)!;
        const mine = tickets.filter((t) => t.lineIndex === lineIndex);
        const lineGross = mine.reduce((acc, t) => acc.add(t.gross), zero());
        const lineDiscount = mine.reduce((acc, t) => acc.add(t.discount), zero());
        return {
            ticketTypeId: type.id,
            ticketTypeName: type.name,
            quantity: line.quantity,
            unitPrice: type.price,
            lineGross,
            lineDiscount,
            lineNet: lineGross.sub(lineDiscount),
        };
    });

    const grossAmount = lines.reduce((acc, l) => acc.add(l.lineGross), zero());
    const discountAmount = lines.reduce((acc, l) => acc.add(l.lineDiscount), zero());

    const membershipTickets = tickets.filter((t) => t.fromMembership);
    const membershipDiscount = membershipTickets.reduce((acc, t) => acc.add(t.discount), zero());

    return {
        tickets: quotedTickets,
        lines,
        grossAmount,
        discountAmount,
        netAmount: grossAmount.sub(discountAmount),
        ticketCount: tickets.length,
        membershipDiscount,
        membershipTicketCount: membershipTickets.length,
        appliedRules: [...summaries.values()],
    };
}
