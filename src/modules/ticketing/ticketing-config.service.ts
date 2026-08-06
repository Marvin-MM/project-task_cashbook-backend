/**
 * Configuring the desk: where the money goes, what runs on which night, what
 * each tier costs, and which offers apply.
 *
 * Everything here is behind MANAGE_TICKETING. An attendant sells at the prices
 * they are given and cannot change them — which is the whole reason the desk can
 * be two taps.
 */
import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError, ConflictError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { toDecimal } from '../../core/finance/money';
import { toDateColumn } from '../../core/time/workspace-clock';
import { provisionWorkspaceAccounting, ensureCashbookLedgerAccount } from '../../core/ledger/coa.seed';
import {
    UpdateTicketSettingsDto,
    ProvisionTicketingDto,
    CreateSessionDto,
    UpdateSessionDto,
    CreateTicketTypeDto,
    UpdateTicketTypeDto,
    CreateDiscountRuleDto,
    UpdateDiscountRuleDto,
} from './ticketing.dto';

@injectable()
export class TicketingConfigService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    // ─── Settings ─────────────────────────────────────

    async getSettings(workspaceId: string) {
        const settings = await this.prisma.ticketSettings.findUnique({
            where: { workspaceId },
            include: {
                cashbook: { select: { id: true, name: true, currency: true } },
                revenueCategory: { select: { id: true, name: true } },
                defaultPaymentMode: { select: { id: true, name: true } },
            },
        });

        const [cashbooks, categories, paymentModes] = await Promise.all([
            this.prisma.cashbook.findMany({
                where: { workspaceId, isActive: true },
                select: { id: true, name: true, currency: true },
                orderBy: { name: 'asc' },
            }),
            this.prisma.category.findMany({
                where: { workspaceId, isActive: true },
                select: { id: true, name: true },
                orderBy: { name: 'asc' },
            }),
            this.prisma.paymentMode.findMany({
                where: { workspaceId, isActive: true },
                select: { id: true, name: true },
                orderBy: { name: 'asc' },
            }),
        ]);

        return {
            settings: settings ?? null,
            configured: settings?.isConfigured ?? false,
            options: { cashbooks, categories, paymentModes },
        };
    }

    /**
     * Point the desk at a book and a category.
     *
     * `isConfigured` is derived rather than set by the caller: it is true exactly
     * when there is somewhere for the money to go. Letting a client assert it
     * would mean a desk that believes it is ready and fails on the first sale of
     * the night.
     */
    async updateSettings(workspaceId: string, userId: string, dto: UpdateTicketSettingsDto) {
        if (dto.cashbookId) {
            const cashbook = await this.prisma.cashbook.findUnique({
                where: { id: dto.cashbookId },
                select: { workspaceId: true, isActive: true },
            });
            if (!cashbook || cashbook.workspaceId !== workspaceId || !cashbook.isActive) {
                throw new AppError('Choose an active book in this workspace', 400, 'INVALID_CASHBOOK');
            }
        }
        if (dto.revenueCategoryId) {
            await this.assertBelongs('category', dto.revenueCategoryId, workspaceId);
        }
        if (dto.defaultPaymentModeId) {
            await this.assertBelongs('paymentMode', dto.defaultPaymentModeId, workspaceId);
        }

        const existing = await this.prisma.ticketSettings.findUnique({ where: { workspaceId } });
        const next = {
            cashbookId: dto.cashbookId !== undefined ? dto.cashbookId : existing?.cashbookId ?? null,
            revenueCategoryId: dto.revenueCategoryId !== undefined
                ? dto.revenueCategoryId
                : existing?.revenueCategoryId ?? null,
            defaultPaymentModeId: dto.defaultPaymentModeId !== undefined
                ? dto.defaultPaymentModeId
                : existing?.defaultPaymentModeId ?? null,
            dayStartMinutes: dto.dayStartMinutes ?? existing?.dayStartMinutes ?? 0,
            allowSelfVoid: dto.allowSelfVoid ?? existing?.allowSelfVoid ?? true,
        };

        const settings = await this.prisma.ticketSettings.upsert({
            where: { workspaceId },
            create: { workspaceId, ...next, isConfigured: Boolean(next.cashbookId) },
            update: { ...next, isConfigured: Boolean(next.cashbookId) },
        });

        await this.audit(workspaceId, userId, AuditAction.TICKET_SETTINGS_UPDATED,
            'ticket_settings', settings.id, { changes: dto });

        return settings;
    }

    /**
     * Create the dedicated gate book in one click.
     *
     * Ticket volume is the reason this exists: hundreds of entries a night in a
     * shared operational book buries everything else in it. A separate book keeps
     * them apart without hiding them — the ledger is workspace-scoped, so
     * org-wide reports are unaffected.
     */
    async provision(workspaceId: string, userId: string, dto: ProvisionTicketingDto) {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { defaultCurrency: true },
        });
        if (!workspace) throw new NotFoundError('Workspace');

        const existing = await this.prisma.ticketSettings.findUnique({ where: { workspaceId } });
        if (existing?.cashbookId) {
            throw new ConflictError('Ticketing already has a book. Change it in settings instead.');
        }

        return this.prisma.$transaction(async (tx) => {
            // Seeds the chart of accounts if it is somehow absent, and is a no-op
            // when it is not — the same call workspace creation makes.
            await provisionWorkspaceAccounting(tx, workspaceId, workspace.defaultCurrency);

            const cashbook = await tx.cashbook.create({
                data: {
                    workspaceId,
                    name: dto.cashbookName,
                    description: 'Gate takings. Entries here are posted by the ticket desk.',
                    currency: workspace.defaultCurrency,
                },
            });

            // This book's private "unallocated book cash" account, exactly as
            // CashbooksService.create provisions one. Without it the book cannot
            // post a journal, and the first sale of the night would fail.
            await ensureCashbookLedgerAccount(tx, {
                id: cashbook.id,
                workspaceId,
                name: cashbook.name,
                currency: cashbook.currency,
            });

            const category = await tx.category.upsert({
                where: { workspaceId_name: { workspaceId, name: dto.categoryName } },
                update: {},
                create: { workspaceId, name: dto.categoryName, color: '#6366f1' },
            });

            const settings = await tx.ticketSettings.upsert({
                where: { workspaceId },
                create: {
                    workspaceId,
                    cashbookId: cashbook.id,
                    revenueCategoryId: category.id,
                    isConfigured: true,
                },
                update: {
                    cashbookId: cashbook.id,
                    revenueCategoryId: category.id,
                    isConfigured: true,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TICKET_SETTINGS_UPDATED,
                    resource: 'ticket_settings',
                    resourceId: settings.id,
                    details: {
                        provisioned: true,
                        cashbookId: cashbook.id,
                        categoryId: category.id,
                    } as any,
                },
            });

            return { settings, cashbook, category };
        });
    }

    // ─── Sessions ─────────────────────────────────────

    async listSessions(workspaceId: string) {
        return this.prisma.ticketSession.findMany({
            where: { workspaceId },
            include: {
                types: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
                rules: { include: { membershipTier: { select: { id: true, name: true } } } },
                _count: { select: { days: true } },
            },
            orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { dayOfWeek: 'asc' }],
        });
    }

    async createSession(workspaceId: string, userId: string, dto: CreateSessionDto) {
        try {
            const session = await this.prisma.ticketSession.create({
                data: {
                    workspaceId,
                    name: dto.name,
                    description: dto.description ?? null,
                    dayOfWeek: dto.dayOfWeek ?? null,
                    specificDate: dto.specificDate ? toDateColumn(dto.specificDate) : null,
                    capacity: dto.capacity ?? null,
                    sortOrder: dto.sortOrder ?? 0,
                },
            });
            await this.audit(workspaceId, userId, AuditAction.TICKET_SESSION_CREATED,
                'ticket_session', session.id, { name: dto.name, dayOfWeek: dto.dayOfWeek });
            return session;
        } catch (error: any) {
            // The partial unique indexes: one active session per weekday, one per
            // date. Two would make "the session running tonight" ambiguous.
            if (error?.code === 'P2002') {
                throw new ConflictError(
                    dto.specificDate
                        ? 'That date already has a session. Edit it, or archive it first.'
                        : 'That weekday already has a session. Edit it, or archive it first.',
                );
            }
            throw error;
        }
    }

    async updateSession(workspaceId: string, sessionId: string, userId: string, dto: UpdateSessionDto) {
        await this.assertBelongs('ticketSession', sessionId, workspaceId);
        const session = await this.prisma.ticketSession.update({
            where: { id: sessionId },
            data: {
                ...(dto.name !== undefined ? { name: dto.name } : {}),
                ...(dto.description !== undefined ? { description: dto.description } : {}),
                ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
                ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
                ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            },
        });
        await this.audit(workspaceId, userId, AuditAction.TICKET_SESSION_UPDATED,
            'ticket_session', sessionId, { changes: dto });
        return session;
    }

    /**
     * Sessions are archived, never deleted, once a night has been sold against
     * them — the tickets reference the tiers, and the tiers reference the
     * session. Deleting would take last month's takings with it.
     */
    async deleteSession(workspaceId: string, sessionId: string, userId: string) {
        await this.assertBelongs('ticketSession', sessionId, workspaceId);

        const used = await this.prisma.ticketDay.count({ where: { sessionId } });
        if (used > 0) {
            const archived = await this.prisma.ticketSession.update({
                where: { id: sessionId },
                data: { isActive: false },
            });
            await this.audit(workspaceId, userId, AuditAction.TICKET_SESSION_UPDATED,
                'ticket_session', sessionId, { archivedInsteadOfDeleted: true, daysSold: used });
            return { archived: true, session: archived };
        }

        await this.prisma.ticketSession.delete({ where: { id: sessionId } });
        await this.audit(workspaceId, userId, AuditAction.TICKET_SESSION_DELETED,
            'ticket_session', sessionId, {});
        return { archived: false };
    }

    // ─── Tiers ────────────────────────────────────────

    async createTicketType(
        workspaceId: string, sessionId: string, userId: string, dto: CreateTicketTypeDto,
    ) {
        await this.assertBelongs('ticketSession', sessionId, workspaceId);
        if (dto.categoryId) await this.assertBelongs('category', dto.categoryId, workspaceId);

        try {
            const type = await this.prisma.ticketType.create({
                data: {
                    workspaceId,
                    sessionId,
                    name: dto.name,
                    patronClass: dto.patronClass,
                    price: toDecimal(dto.price),
                    categoryId: dto.categoryId ?? null,
                    capacity: dto.capacity ?? null,
                    sortOrder: dto.sortOrder ?? 0,
                },
            });
            await this.audit(workspaceId, userId, AuditAction.TICKET_TYPE_CREATED,
                'ticket_type', type.id, { sessionId, name: dto.name, price: dto.price });
            return type;
        } catch (error: any) {
            if (error?.code === 'P2002') {
                throw new ConflictError(`"${dto.name}" already exists on this session`);
            }
            throw error;
        }
    }

    /**
     * Editing a price changes what the NEXT sale costs and nothing else. Every
     * sale already rung snapshotted its prices onto its lines and tickets, so
     * last Friday's takings are not rewritten by tonight's price rise.
     */
    async updateTicketType(
        workspaceId: string, typeId: string, userId: string, dto: UpdateTicketTypeDto,
    ) {
        await this.assertBelongs('ticketType', typeId, workspaceId);
        if (dto.categoryId) await this.assertBelongs('category', dto.categoryId, workspaceId);

        const type = await this.prisma.ticketType.update({
            where: { id: typeId },
            data: {
                ...(dto.name !== undefined ? { name: dto.name } : {}),
                ...(dto.patronClass !== undefined ? { patronClass: dto.patronClass } : {}),
                ...(dto.price !== undefined ? { price: toDecimal(dto.price) } : {}),
                ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
                ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
                ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
                ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            },
        });
        await this.audit(workspaceId, userId, AuditAction.TICKET_TYPE_UPDATED,
            'ticket_type', typeId, { changes: dto });
        return type;
    }

    async deleteTicketType(workspaceId: string, typeId: string, userId: string) {
        await this.assertBelongs('ticketType', typeId, workspaceId);

        const sold = await this.prisma.ticket.count({ where: { ticketTypeId: typeId } });
        if (sold > 0) {
            const archived = await this.prisma.ticketType.update({
                where: { id: typeId },
                data: { isActive: false },
            });
            await this.audit(workspaceId, userId, AuditAction.TICKET_TYPE_UPDATED,
                'ticket_type', typeId, { archivedInsteadOfDeleted: true, ticketsSold: sold });
            return { archived: true, type: archived };
        }

        await this.prisma.ticketType.delete({ where: { id: typeId } });
        await this.audit(workspaceId, userId, AuditAction.TICKET_TYPE_DELETED,
            'ticket_type', typeId, {});
        return { archived: false };
    }

    // ─── Offers ───────────────────────────────────────

    async createDiscountRule(workspaceId: string, userId: string, dto: CreateDiscountRuleDto) {
        if (dto.sessionId) await this.assertBelongs('ticketSession', dto.sessionId, workspaceId);
        if (dto.membershipTierId) {
            await this.assertBelongs('membershipTier', dto.membershipTierId, workspaceId);
        }

        const rule = await this.prisma.ticketDiscountRule.create({
            data: {
                workspaceId,
                sessionId: dto.sessionId ?? null,
                name: dto.name,
                type: dto.type,
                valueType: dto.valueType,
                value: toDecimal(dto.value),
                config: dto.config as any,
                membershipTierId: dto.membershipTierId ?? null,
                priority: dto.priority,
                stackable: dto.stackable,
            },
        });
        await this.audit(workspaceId, userId, AuditAction.TICKET_RULE_CREATED,
            'ticket_discount_rule', rule.id, { name: dto.name, type: dto.type });
        return rule;
    }

    async updateDiscountRule(
        workspaceId: string, ruleId: string, userId: string, dto: UpdateDiscountRuleDto,
    ) {
        await this.assertBelongs('ticketDiscountRule', ruleId, workspaceId);
        const rule = await this.prisma.ticketDiscountRule.update({
            where: { id: ruleId },
            data: {
                ...(dto.name !== undefined ? { name: dto.name } : {}),
                ...(dto.valueType !== undefined ? { valueType: dto.valueType } : {}),
                ...(dto.value !== undefined ? { value: toDecimal(dto.value) } : {}),
                ...(dto.config !== undefined ? { config: dto.config as any } : {}),
                ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
                ...(dto.stackable !== undefined ? { stackable: dto.stackable } : {}),
                ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            },
        });
        await this.audit(workspaceId, userId, AuditAction.TICKET_RULE_UPDATED,
            'ticket_discount_rule', ruleId, { changes: dto });
        return rule;
    }

    /**
     * Offers ARE deleted rather than archived. A ticket records which rule
     * discounted it, and that FK is SetNull — so the ticket keeps its discount
     * amount and simply loses the pointer. The money is unchanged either way.
     */
    async deleteDiscountRule(workspaceId: string, ruleId: string, userId: string) {
        await this.assertBelongs('ticketDiscountRule', ruleId, workspaceId);
        await this.prisma.ticketDiscountRule.delete({ where: { id: ruleId } });
        await this.audit(workspaceId, userId, AuditAction.TICKET_RULE_DELETED,
            'ticket_discount_rule', ruleId, {});
        return { deleted: true };
    }

    // ─── Internals ────────────────────────────────────

    private async assertBelongs(
        model: 'category' | 'paymentMode' | 'ticketSession' | 'ticketType'
            | 'membershipTier' | 'ticketDiscountRule',
        id: string,
        workspaceId: string,
    ) {
        const row = await (this.prisma[model] as any).findUnique({
            where: { id },
            select: { workspaceId: true },
        });
        if (!row || row.workspaceId !== workspaceId) {
            throw new NotFoundError(model);
        }
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
