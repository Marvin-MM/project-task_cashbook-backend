import { z } from 'zod';

/** Matches the Decimal(20, 4) money columns, as entries.dto.ts does. */
const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Amount must be a valid decimal number with up to 4 decimal places',
);

const patronClass = z.enum(['ADULT', 'MINOR', 'OTHER']);
const discountValueType = z.enum(['PERCENT', 'AMOUNT']);
const discountType = z.enum(['GUARDIAN_COMP', 'MEMBERSHIP', 'GROUP', 'MANUAL']);

/**
 * A boolean query param, read correctly.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, which is true for ANY non-empty
 * string — `?flag=false` coerces to `true`. Query params arrive as strings, so
 * that footgun is live on every boolean filter a client might want to turn
 * off explicitly. This only accepts the literal strings a client actually
 * sends and rejects anything else, rather than silently mis-reading it.
 */
const booleanQueryParam = (defaultValue: boolean) =>
    z.union([z.enum(['true', 'false']), z.boolean()])
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
        .default(defaultValue);

// ─── Settings ──────────────────────────────────────────

/**
 * The one-time setup that turns an unlocked module into a working desk.
 *
 * A superadmin unlocking ticketing does not choose these: which book gate money
 * lands in and which category it counts as are chart-of-accounts decisions, and
 * nobody outside the organisation is in a position to make them.
 */
export const updateTicketSettingsSchema = z.object({
    cashbookId: z.string().uuid().nullable().optional(),
    revenueCategoryId: z.string().uuid().nullable().optional(),
    defaultPaymentModeId: z.string().uuid().nullable().optional(),
    /** Minutes past local midnight at which a new ticketing day starts. */
    dayStartMinutes: z.coerce.number().int().min(0).max(1439).optional(),
    allowSelfVoid: z.boolean().optional(),
});

/** One-click creation of the dedicated gate book and its revenue category. */
export const provisionTicketingSchema = z.object({
    cashbookName: z.string().min(1).max(100).default('Gate / Tickets'),
    categoryName: z.string().min(1).max(100).default('Ticket Sales'),
});

// ─── Sessions, tiers and offers ────────────────────────

/**
 * A session is either a weekly pattern or a one-off date for a specific day,
 * never both. The database asserts the same thing; stating it here means the
 * caller gets a field-level message rather than a constraint violation.
 */
export const createSessionSchema = z.object({
    name: z.string().min(1, 'Give the session a name').max(100),
    description: z.string().max(500).optional(),
    dayOfWeek: z.coerce.number().int().min(0).max(6).nullable().optional(),
    specificDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
    capacity: z.coerce.number().int().min(1).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
}).refine(
    (v) => (v.dayOfWeek !== null && v.dayOfWeek !== undefined)
        !== (v.specificDate !== null && v.specificDate !== undefined),
    { message: 'A session repeats on a weekday or covers one date — set exactly one' },
);

export const updateSessionSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    capacity: z.coerce.number().int().min(1).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
});

export const createTicketTypeSchema = z.object({
    name: z.string().min(1, 'Name the tier').max(100),
    patronClass: patronClass.default('ADULT'),
    price: decimalString,
    categoryId: z.string().uuid().nullable().optional(),
    capacity: z.coerce.number().int().min(1).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
});

export const updateTicketTypeSchema = createTicketTypeSchema.partial().extend({
    isActive: z.boolean().optional(),
});

/**
 * `config` is deliberately loose here and interpreted by pricing.ts, so adding
 * an offer shape does not mean a migration. The known shapes:
 *
 *   GUARDIAN_COMP { minMinors, compPatronClass, maxCompPerSale }
 *   GROUP         { minQuantity, ticketTypeIds }
 *   MEMBERSHIP    { ticketTypeIds }
 *   MANUAL        { ticketTypeIds }
 */
export const createDiscountRuleSchema = z.object({
    sessionId: z.string().uuid().nullable().optional(),
    name: z.string().min(1, 'Name the offer').max(100),
    type: discountType,
    valueType: discountValueType.default('PERCENT'),
    value: decimalString,
    config: z.record(z.string(), z.unknown()).default({}),
    membershipTierId: z.string().uuid().nullable().optional(),
    priority: z.coerce.number().int().min(0).default(100),
    stackable: z.boolean().default(false),
}).refine(
    (v) => v.valueType !== 'PERCENT' || Number(v.value) <= 100,
    { message: 'A percentage offer cannot exceed 100', path: ['value'] },
).refine(
    (v) => v.type !== 'MEMBERSHIP' || Boolean(v.membershipTierId),
    { message: 'A membership offer must name the tier it belongs to', path: ['membershipTierId'] },
);

export const updateDiscountRuleSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    valueType: discountValueType.optional(),
    value: decimalString.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    priority: z.coerce.number().int().min(0).optional(),
    stackable: z.boolean().optional(),
    isActive: z.boolean().optional(),
});

// ─── The desk ──────────────────────────────────────────

const saleLines = z.array(z.object({
    ticketTypeId: z.string().uuid('Choose a ticket type'),
    quantity: z.coerce.number().int().min(1).max(500),
})).min(1, 'Add at least one ticket');

/**
 * A price preview. Same inputs as a sale minus the money, because the answer has
 * to be computed by the same function that will charge — a preview derived
 * differently is a preview that eventually lies.
 */
export const quoteSaleSchema = z.object({
    sessionId: z.string().uuid().optional(),
    lines: saleLines,
    memberNo: z.string().max(50).optional(),
    manualRuleIds: z.array(z.string().uuid()).optional(),
});

/**
 * Confirming a sale.
 *
 * No prices here, deliberately. The client sends what was asked for, never what
 * it costs — the server re-prices from its own tiers and offers. A basket that
 * carried its own totals would be a basket a modified client could discount.
 */
export const createSaleSchema = z.object({
    sessionId: z.string().uuid().optional(),
    lines: saleLines,
    /** The wallet the money went into: cash tin, mobile money, bank. */
    accountId: z.string().uuid('Choose where the money went'),
    paymentModeId: z.string().uuid().nullable().optional(),
    memberNo: z.string().max(50).optional(),
    manualRuleIds: z.array(z.string().uuid()).optional(),
    note: z.string().max(500).optional(),
});

export const voidSaleSchema = z.object({
    /**
     * Required, and for the same reason reassigning an entry requires one: a
     * reversal looks like tidying up when you do it and like a discrepancy when
     * somebody finds it later. The audit row is only worth having if it says why.
     */
    reason: z.string().min(3, 'Say why this sale is being reversed').max(500),
});

export const listSalesSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(50),
    /** Defaults to the current business day — see the service. */
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sessionId: z.string().uuid().optional(),
    soldById: z.string().uuid().optional(),
    shiftId: z.string().uuid().optional(),
    includeVoided: booleanQueryParam(true),
});

// ─── Days and shifts ───────────────────────────────────

export const closeDaySchema = z.object({
    notes: z.string().max(1000).optional(),
});

export const openShiftSchema = z.object({
    openingFloat: decimalString.default('0'),
    /** Supervisors may open a drawer on somebody else's behalf. */
    attendantId: z.string().uuid().optional(),
});

/**
 * Counting the drawer.
 *
 * Counts are per wallet, not one total, because a gate takes cash and mobile
 * money in the same shift and they are separate pots with separate risks. One
 * combined figure hides a cash shortfall behind a mobile-money surplus, which is
 * precisely the discrepancy a drawer count exists to surface.
 *
 * A wallet the shift sold into and the attendant did not count is treated as
 * zero counted, so it shows up short rather than quietly disappearing.
 */
export const closeShiftSchema = z.object({
    counted: z.array(z.object({
        accountId: z.string().uuid(),
        amount: decimalString,
    })).default([]),
    notes: z.string().max(1000).optional(),
});

export const listDaysSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(30),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(['OPEN', 'CLOSED']).optional(),
});

// ─── Memberships ───────────────────────────────────────

export const createMembershipTierSchema = z.object({
    name: z.string().min(1, 'Name the tier').max(100),
    description: z.string().max(500).optional(),
    discountValueType: discountValueType.default('PERCENT'),
    discountValue: decimalString.default('0'),
    appliesToTicketTypeIds: z.array(z.string().uuid()).default([]),
    maxUsesPerDay: z.coerce.number().int().min(1).nullable().optional(),
    validityMonths: z.coerce.number().int().min(1).nullable().optional(),
    price: decimalString.nullable().optional(),
}).refine(
    (v) => v.discountValueType !== 'PERCENT' || Number(v.discountValue) <= 100,
    { message: 'A percentage discount cannot exceed 100', path: ['discountValue'] },
);

export const updateMembershipTierSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    discountValueType: discountValueType.optional(),
    discountValue: decimalString.optional(),
    appliesToTicketTypeIds: z.array(z.string().uuid()).optional(),
    maxUsesPerDay: z.coerce.number().int().min(1).nullable().optional(),
    validityMonths: z.coerce.number().int().min(1).nullable().optional(),
    price: decimalString.nullable().optional(),
    isActive: z.boolean().optional(),
});

/**
 * Issuing a card.
 *
 * Either against an existing contact or by naming a new one — the service
 * find-or-creates a CUSTOMER contact, so a member's tickets, receipts and any
 * invoices all hang off one customer record rather than three spellings of the
 * same person.
 *
 * `accountId` is needed only when the tier charges a joining fee, because then
 * this posts an income entry like any other sale.
 */
export const createMembershipSchema = z.object({
    tierId: z.string().uuid('Choose a tier'),
    contactId: z.string().uuid().optional(),
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(50).optional(),
    /** Omit to generate the next M-00001. Supply to keep a pre-printed card number. */
    memberNo: z.string().min(1).max(50).optional(),
    validFrom: z.string().datetime().optional(),
    accountId: z.string().uuid().optional(),
    paymentModeId: z.string().uuid().nullable().optional(),
    notes: z.string().max(500).optional(),
}).refine(
    (v) => Boolean(v.contactId) || Boolean(v.name),
    { message: 'Choose an existing customer or give a name for a new one', path: ['name'] },
);

export const updateMembershipSchema = z.object({
    tierId: z.string().uuid().optional(),
    status: z.enum(['ACTIVE', 'EXPIRED', 'SUSPENDED', 'CANCELLED']).optional(),
    validUntil: z.string().datetime().nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
});

export const renewMembershipSchema = z.object({
    accountId: z.string().uuid().optional(),
    paymentModeId: z.string().uuid().nullable().optional(),
});

export const listMembershipsSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    search: z.string().max(100).optional(),
    tierId: z.string().uuid().optional(),
    status: z.enum(['ACTIVE', 'EXPIRED', 'SUSPENDED', 'CANCELLED']).optional(),
});

export const lookupMembershipSchema = z.object({
    memberNo: z.string().min(1, 'Enter a member number').max(50),
});

// ─── Analytics ─────────────────────────────────────────

export const analyticsRangeSchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sessionId: z.string().uuid().optional(),
});

export type UpdateTicketSettingsDto = z.infer<typeof updateTicketSettingsSchema>;
export type ProvisionTicketingDto = z.infer<typeof provisionTicketingSchema>;
export type CreateSessionDto = z.infer<typeof createSessionSchema>;
export type UpdateSessionDto = z.infer<typeof updateSessionSchema>;
export type CreateTicketTypeDto = z.infer<typeof createTicketTypeSchema>;
export type UpdateTicketTypeDto = z.infer<typeof updateTicketTypeSchema>;
export type CreateDiscountRuleDto = z.infer<typeof createDiscountRuleSchema>;
export type UpdateDiscountRuleDto = z.infer<typeof updateDiscountRuleSchema>;
export type QuoteSaleDto = z.infer<typeof quoteSaleSchema>;
export type CreateSaleDto = z.infer<typeof createSaleSchema>;
export type VoidSaleDto = z.infer<typeof voidSaleSchema>;
export type ListSalesDto = z.infer<typeof listSalesSchema>;
export type CloseDayDto = z.infer<typeof closeDaySchema>;
export type OpenShiftDto = z.infer<typeof openShiftSchema>;
export type CloseShiftDto = z.infer<typeof closeShiftSchema>;
export type ListDaysDto = z.infer<typeof listDaysSchema>;
export type CreateMembershipTierDto = z.infer<typeof createMembershipTierSchema>;
export type UpdateMembershipTierDto = z.infer<typeof updateMembershipTierSchema>;
export type CreateMembershipDto = z.infer<typeof createMembershipSchema>;
export type UpdateMembershipDto = z.infer<typeof updateMembershipSchema>;
export type RenewMembershipDto = z.infer<typeof renewMembershipSchema>;
export type ListMembershipsDto = z.infer<typeof listMembershipsSchema>;
export type LookupMembershipDto = z.infer<typeof lookupMembershipSchema>;
export type AnalyticsRangeDto = z.infer<typeof analyticsRangeSchema>;
