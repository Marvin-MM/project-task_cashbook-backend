/**
 * The loyalty programme.
 *
 * A membership is layered on an existing Contact of type CUSTOMER rather than
 * carrying its own name and phone. That coupling is the point: a member who is
 * also invoiced, or receipted, or owes money, is one customer record with one
 * history — not three spellings of the same person scattered across three
 * modules.
 *
 * Selling a membership posts its own income entry, through the same
 * createEntryWithin the desk uses. A joining fee is revenue; leaving it out of
 * the books because it was collected by the ticketing module rather than the
 * cashbook module would be an accident of code structure showing up as missing
 * income.
 */
import { injectable, inject } from 'tsyringe';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AppError, NotFoundError, ConflictError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { toDecimal } from '../../core/finance/money';
import { withFinancialTransaction } from '../../core/db/transaction';
import { EntriesService } from '../entries/entries.service';
import {
    CreateMembershipTierDto,
    UpdateMembershipTierDto,
    CreateMembershipDto,
    UpdateMembershipDto,
    RenewMembershipDto,
    ListMembershipsDto,
} from './ticketing.dto';

@injectable()
export class MembershipsService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
        private entriesService: EntriesService,
    ) { }

    // ─── Tiers ────────────────────────────────────────

    async listTiers(workspaceId: string) {
        return this.prisma.membershipTier.findMany({
            where: { workspaceId },
            include: { _count: { select: { memberships: true } } },
            orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        });
    }

    async createTier(workspaceId: string, userId: string, dto: CreateMembershipTierDto) {
        try {
            const tier = await this.prisma.membershipTier.create({
                data: {
                    workspaceId,
                    name: dto.name,
                    description: dto.description ?? null,
                    discountValueType: dto.discountValueType,
                    discountValue: toDecimal(dto.discountValue),
                    appliesToTicketTypeIds: dto.appliesToTicketTypeIds,
                    maxUsesPerDay: dto.maxUsesPerDay ?? null,
                    validityMonths: dto.validityMonths ?? null,
                    price: dto.price ? toDecimal(dto.price) : null,
                },
            });

            // A tier is inert until an offer references it, so create the
            // matching MEMBERSHIP rule here rather than making the manager
            // configure the same discount twice in two places.
            await this.prisma.ticketDiscountRule.create({
                data: {
                    workspaceId,
                    name: `${dto.name} member discount`,
                    type: 'MEMBERSHIP',
                    valueType: dto.discountValueType,
                    value: toDecimal(dto.discountValue),
                    config: { ticketTypeIds: dto.appliesToTicketTypeIds } as any,
                    membershipTierId: tier.id,
                    priority: 50,
                },
            });

            await this.audit(workspaceId, userId, AuditAction.MEMBERSHIP_TIER_CREATED,
                'membership_tier', tier.id, { name: dto.name });
            return tier;
        } catch (error: any) {
            if (error?.code === 'P2002') {
                throw new ConflictError(`A tier called "${dto.name}" already exists`);
            }
            throw error;
        }
    }

    /**
     * Editing a tier keeps its offer in step.
     *
     * The rule created alongside the tier is the thing pricing actually reads;
     * updating one without the other is how a "20% off" tier quietly keeps
     * giving 10%.
     */
    async updateTier(
        workspaceId: string, tierId: string, userId: string, dto: UpdateMembershipTierDto,
    ) {
        await this.assertTier(workspaceId, tierId);

        const tier = await this.prisma.membershipTier.update({
            where: { id: tierId },
            data: {
                ...(dto.name !== undefined ? { name: dto.name } : {}),
                ...(dto.description !== undefined ? { description: dto.description } : {}),
                ...(dto.discountValueType !== undefined
                    ? { discountValueType: dto.discountValueType } : {}),
                ...(dto.discountValue !== undefined
                    ? { discountValue: toDecimal(dto.discountValue) } : {}),
                ...(dto.appliesToTicketTypeIds !== undefined
                    ? { appliesToTicketTypeIds: dto.appliesToTicketTypeIds } : {}),
                ...(dto.maxUsesPerDay !== undefined ? { maxUsesPerDay: dto.maxUsesPerDay } : {}),
                ...(dto.validityMonths !== undefined ? { validityMonths: dto.validityMonths } : {}),
                ...(dto.price !== undefined
                    ? { price: dto.price === null ? null : toDecimal(dto.price) } : {}),
                ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            },
        });

        const offerChanged = dto.discountValue !== undefined
            || dto.discountValueType !== undefined
            || dto.appliesToTicketTypeIds !== undefined
            || dto.isActive !== undefined;

        if (offerChanged) {
            await this.prisma.ticketDiscountRule.updateMany({
                where: { workspaceId, membershipTierId: tierId, type: 'MEMBERSHIP' },
                data: {
                    ...(dto.discountValueType !== undefined
                        ? { valueType: dto.discountValueType } : {}),
                    ...(dto.discountValue !== undefined
                        ? { value: toDecimal(dto.discountValue) } : {}),
                    ...(dto.appliesToTicketTypeIds !== undefined
                        ? { config: { ticketTypeIds: dto.appliesToTicketTypeIds } as any } : {}),
                    ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
                },
            });
        }

        await this.audit(workspaceId, userId, AuditAction.MEMBERSHIP_TIER_UPDATED,
            'membership_tier', tierId, { changes: dto });
        return tier;
    }

    // ─── Cards ────────────────────────────────────────

    async list(workspaceId: string, query: ListMembershipsDto) {
        const where: Prisma.MembershipWhereInput = {
            workspaceId,
            ...(query.tierId ? { tierId: query.tierId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.search
                ? {
                    OR: [
                        { memberNo: { contains: query.search, mode: 'insensitive' as const } },
                        { contact: { name: { contains: query.search, mode: 'insensitive' as const } } },
                        { contact: { phone: { contains: query.search, mode: 'insensitive' as const } } },
                    ],
                }
                : {}),
        };

        const [total, data] = await Promise.all([
            this.prisma.membership.count({ where }),
            this.prisma.membership.findMany({
                where,
                include: {
                    tier: { select: { id: true, name: true, discountValue: true, discountValueType: true } },
                    contact: { select: { id: true, name: true, email: true, phone: true } },
                    _count: { select: { usages: true, sales: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);

        const totalPages = Math.ceil(total / query.limit) || 1;
        return {
            data,
            pagination: {
                page: query.page, limit: query.limit, total, totalPages,
                hasNext: query.page < totalPages, hasPrevious: query.page > 1,
            },
        };
    }

    /**
     * The desk lookup: type a number, see whether it is worth anything.
     *
     * Answers with a reason rather than a 404, because the attendant needs to
     * tell the customer something and the queue is waiting. "Expired on 3 March"
     * ends the conversation; "not found" starts one.
     */
    async lookup(workspaceId: string, memberNo: string) {
        const membership = await this.prisma.membership.findUnique({
            where: { workspaceId_memberNo: { workspaceId, memberNo: memberNo.trim() } },
            include: {
                tier: true,
                contact: { select: { id: true, name: true, phone: true } },
            },
        });

        if (!membership) {
            return { found: false, valid: false, reason: 'NOT_FOUND' as const, membership: null };
        }

        const now = new Date();
        let reason: 'OK' | 'INACTIVE' | 'EXPIRED' | 'NOT_YET_VALID' | 'TIER_INACTIVE' = 'OK';
        if (membership.status !== 'ACTIVE') reason = 'INACTIVE';
        else if (!membership.tier.isActive) reason = 'TIER_INACTIVE';
        else if (membership.validUntil && membership.validUntil < now) reason = 'EXPIRED';
        else if (membership.validFrom > now) reason = 'NOT_YET_VALID';

        return { found: true, valid: reason === 'OK', reason, membership };
    }

    /**
     * Issue a card.
     *
     * When the tier charges a joining fee this posts an income entry in the same
     * transaction, so a membership cannot exist without the money that paid for
     * it having reached the books, or vice versa.
     */
    async create(workspaceId: string, userId: string, dto: CreateMembershipDto) {
        const tier = await this.assertTier(workspaceId, dto.tierId);
        const fee = tier.price ?? null;

        if (fee && fee.greaterThan(0) && !dto.accountId) {
            throw new AppError(
                `"${tier.name}" costs ${fee.toFixed(0)}. Say which wallet the money went into.`,
                400,
                'ACCOUNT_REQUIRED',
            );
        }

        const settings = fee && fee.greaterThan(0)
            ? await this.requireConfiguredSettings(workspaceId)
            : null;

        return withFinancialTransaction(this.prisma, async (tx) => {
            const contactId = await this.findOrCreateContact(tx, workspaceId, dto);
            const memberNo = dto.memberNo?.trim() || await this.nextMemberNo(tx, workspaceId);

            const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date();
            const validUntil = tier.validityMonths
                ? addMonths(validFrom, tier.validityMonths)
                : null;

            let entryId: string | null = null;
            if (fee && fee.greaterThan(0) && settings) {
                const entry = await this.entriesService.createEntryWithin(
                    tx, settings.cashbookId!, userId,
                    {
                        type: 'INCOME',
                        amount: fee.toFixed(4),
                        description: `Membership: ${tier.name} — ${memberNo}`,
                        categoryId: settings.revenueCategoryId ?? undefined,
                        accountId: dto.accountId!,
                        paymentModeId: dto.paymentModeId
                            ?? settings.defaultPaymentModeId ?? undefined,
                        contactId,
                        entryDate: new Date().toISOString(),
                    } as any,
                );
                entryId = entry.id;
            }

            try {
                const membership = await tx.membership.create({
                    data: {
                        workspaceId,
                        contactId,
                        tierId: tier.id,
                        memberNo,
                        validFrom,
                        validUntil,
                        issuedById: userId,
                        entryId,
                        notes: dto.notes ?? null,
                    },
                    include: {
                        tier: { select: { id: true, name: true } },
                        contact: { select: { id: true, name: true, phone: true } },
                    },
                });

                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: AuditAction.MEMBERSHIP_ISSUED,
                        resource: 'membership',
                        resourceId: membership.id,
                        details: {
                            memberNo, tierId: tier.id, contactId,
                            fee: fee?.toFixed(4) ?? null, entryId,
                        } as any,
                    },
                });

                return membership;
            } catch (error: any) {
                if (error?.code === 'P2002') {
                    throw new ConflictError(`Member number "${memberNo}" is already in use`);
                }
                throw error;
            }
        });
    }

    async update(workspaceId: string, membershipId: string, userId: string, dto: UpdateMembershipDto) {
        const existing = await this.prisma.membership.findUnique({ where: { id: membershipId } });
        if (!existing || existing.workspaceId !== workspaceId) throw new NotFoundError('Membership');
        if (dto.tierId) await this.assertTier(workspaceId, dto.tierId);

        const membership = await this.prisma.membership.update({
            where: { id: membershipId },
            data: {
                ...(dto.tierId !== undefined ? { tierId: dto.tierId } : {}),
                ...(dto.status !== undefined ? { status: dto.status } : {}),
                ...(dto.validUntil !== undefined
                    ? { validUntil: dto.validUntil ? new Date(dto.validUntil) : null } : {}),
                ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            },
            include: {
                tier: { select: { id: true, name: true } },
                contact: { select: { id: true, name: true, phone: true } },
            },
        });

        await this.audit(workspaceId, userId, AuditAction.MEMBERSHIP_UPDATED,
            'membership', membershipId, { changes: dto });
        return membership;
    }

    /**
     * Renew.
     *
     * Extends from whichever is later, the current expiry or today: renewing
     * early should not lose the remaining time, and renewing late should not
     * back-date the new period into months already gone.
     */
    async renew(workspaceId: string, membershipId: string, userId: string, dto: RenewMembershipDto) {
        const existing = await this.prisma.membership.findUnique({
            where: { id: membershipId },
            include: { tier: true },
        });
        if (!existing || existing.workspaceId !== workspaceId) throw new NotFoundError('Membership');

        if (!existing.tier.validityMonths) {
            throw new AppError(
                `"${existing.tier.name}" does not expire, so there is nothing to renew.`,
                400,
                'TIER_DOES_NOT_EXPIRE',
            );
        }

        const fee = existing.tier.price ?? null;
        if (fee && fee.greaterThan(0) && !dto.accountId) {
            throw new AppError(
                `Renewing costs ${fee.toFixed(0)}. Say which wallet the money went into.`,
                400,
                'ACCOUNT_REQUIRED',
            );
        }
        const settings = fee && fee.greaterThan(0)
            ? await this.requireConfiguredSettings(workspaceId)
            : null;

        const now = new Date();
        const base = existing.validUntil && existing.validUntil > now ? existing.validUntil : now;
        const validUntil = addMonths(base, existing.tier.validityMonths);

        return withFinancialTransaction(this.prisma, async (tx) => {
            if (fee && fee.greaterThan(0) && settings) {
                await this.entriesService.createEntryWithin(
                    tx, settings.cashbookId!, userId,
                    {
                        type: 'INCOME',
                        amount: fee.toFixed(4),
                        description: `Membership renewal: ${existing.tier.name} — ${existing.memberNo}`,
                        categoryId: settings.revenueCategoryId ?? undefined,
                        accountId: dto.accountId!,
                        paymentModeId: dto.paymentModeId
                            ?? settings.defaultPaymentModeId ?? undefined,
                        contactId: existing.contactId,
                        entryDate: now.toISOString(),
                    } as any,
                );
            }

            const membership = await tx.membership.update({
                where: { id: membershipId },
                data: { validUntil, status: 'ACTIVE' },
                include: {
                    tier: { select: { id: true, name: true } },
                    contact: { select: { id: true, name: true, phone: true } },
                },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.MEMBERSHIP_RENEWED,
                    resource: 'membership',
                    resourceId: membershipId,
                    details: {
                        memberNo: existing.memberNo,
                        previousValidUntil: existing.validUntil,
                        validUntil,
                        fee: fee?.toFixed(4) ?? null,
                    } as any,
                },
            });

            return membership;
        });
    }

    /** What a card has actually earned its holder. */
    async getUsage(workspaceId: string, membershipId: string) {
        const membership = await this.prisma.membership.findUnique({
            where: { id: membershipId },
            include: {
                tier: { select: { id: true, name: true } },
                contact: { select: { id: true, name: true, phone: true, email: true } },
            },
        });
        if (!membership || membership.workspaceId !== workspaceId) {
            throw new NotFoundError('Membership');
        }

        const [agg, recent] = await Promise.all([
            this.prisma.membershipUsage.aggregate({
                where: { membershipId },
                _sum: { discountAmount: true, ticketCount: true },
                _count: true,
            }),
            this.prisma.membershipUsage.findMany({
                where: { membershipId },
                include: {
                    ticketDay: { select: { businessDate: true } },
                    sale: { select: { id: true, netAmount: true, status: true } },
                },
                orderBy: { usedAt: 'desc' },
                take: 50,
            }),
        ]);

        return {
            membership,
            totals: {
                redemptions: agg._count,
                ticketsDiscounted: agg._sum.ticketCount ?? 0,
                totalSaved: (agg._sum.discountAmount ?? new Decimal(0)).toFixed(4),
            },
            recent,
        };
    }

    // ─── Internals ────────────────────────────────────

    /**
     * One customer record per person.
     *
     * Matched on phone first, then email, then exact name — phone being the thing
     * a desk actually asks for and the thing least likely to be spelled two ways.
     */
    private async findOrCreateContact(
        tx: Prisma.TransactionClient,
        workspaceId: string,
        dto: CreateMembershipDto,
    ): Promise<string> {
        if (dto.contactId) {
            const contact = await tx.contact.findUnique({ where: { id: dto.contactId } });
            if (!contact || contact.workspaceId !== workspaceId) throw new NotFoundError('Contact');
            return contact.id;
        }

        const match = await tx.contact.findFirst({
            where: {
                workspaceId,
                OR: [
                    ...(dto.phone ? [{ phone: dto.phone }] : []),
                    ...(dto.email ? [{ email: dto.email }] : []),
                    { name: dto.name!, type: 'CUSTOMER' as const },
                ],
            },
        });
        if (match) return match.id;

        const created = await tx.contact.create({
            data: {
                workspaceId,
                type: 'CUSTOMER',
                name: dto.name!,
                email: dto.email ?? null,
                phone: dto.phone ?? null,
            },
        });
        return created.id;
    }

    /**
     * The next M-00001.
     *
     * Derived from the highest existing generated number rather than from a
     * count, so deleting or importing a card cannot hand out a number already in
     * use. The unique constraint is still the backstop under concurrency: two
     * simultaneous issues race, one loses, and the caller sees a conflict.
     */
    private async nextMemberNo(tx: Prisma.TransactionClient, workspaceId: string): Promise<string> {
        const latest = await tx.membership.findFirst({
            where: { workspaceId, memberNo: { startsWith: 'M-' } },
            orderBy: { memberNo: 'desc' },
            select: { memberNo: true },
        });

        const current = latest ? Number.parseInt(latest.memberNo.slice(2), 10) : 0;
        const next = Number.isFinite(current) ? current + 1 : 1;
        return `M-${String(next).padStart(5, '0')}`;
    }

    private async assertTier(workspaceId: string, tierId: string) {
        const tier = await this.prisma.membershipTier.findUnique({ where: { id: tierId } });
        if (!tier || tier.workspaceId !== workspaceId) throw new NotFoundError('Membership tier');
        return tier;
    }

    private async requireConfiguredSettings(workspaceId: string) {
        const settings = await this.prisma.ticketSettings.findUnique({ where: { workspaceId } });
        if (!settings?.isConfigured || !settings.cashbookId) {
            throw new AppError(
                'Ticketing has not been set up yet, so a membership fee has nowhere to post.',
                409,
                'TICKETING_NOT_CONFIGURED',
            );
        }
        return settings;
    }

    private audit(
        workspaceId: string,
        userId: string,
        action: AuditAction,
        resource: string,
        resourceId: string,
        details: Record<string, unknown>,
    ) {
        return this.prisma.auditLog.create({
            data: { userId, workspaceId, action, resource, resourceId, details: details as any },
        });
    }
}

/**
 * Month arithmetic that does not overflow.
 *
 * Adding a month to 31 January gives 28/29 February, not 2/3 March. JavaScript's
 * setMonth rolls over silently, which would hand a member two or three extra
 * days every year they renewed off a long month.
 */
function addMonths(from: Date, months: number): Date {
    const result = new Date(from);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(
        result.getUTCFullYear(), result.getUTCMonth() + 1, 0,
    )).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
}
