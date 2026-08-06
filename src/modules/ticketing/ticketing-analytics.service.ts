/**
 * What the gate is actually doing.
 *
 * Everything here reads the ticketing tables rather than the ledger, on purpose.
 * The ledger knows what the money was; only these tables know how many people
 * came through, at which tier, and how much was given away doing it — which is
 * the question a venue manager is actually asking.
 *
 * Voided sales are excluded everywhere. A reversed sale did not happen, and
 * counting it would make a busy night of mistakes look like a busy night.
 */
import { injectable, inject } from 'tsyringe';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { toDateColumn } from '../../core/time/workspace-clock';
import { ticketClockFor } from './business-day';
import { AnalyticsRangeDto } from './ticketing.dto';

const ZERO = new Decimal(0);
const money = (v: Decimal | null | undefined) => (v ?? ZERO).toFixed(4);

@injectable()
export class TicketingAnalyticsService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    /**
     * Resolve the window.
     *
     * Defaults to the last 30 business days ending today, in the workspace's own
     * timezone and through its own cutover — so "today" at a venue that closes at
     * 3am means the night that is still running, not the calendar date the
     * server happens to be in.
     */
    private async range(workspaceId: string, dto: AnalyticsRangeDto) {
        const clock = await ticketClockFor(this.prisma, workspaceId);
        const to = dto.to ?? clock.businessDate(new Date());
        const from = dto.from ?? clock.addLocalDays(to, -29);
        return { from, to };
    }

    private dayFilter(workspaceId: string, from: string, to: string, sessionId?: string) {
        return {
            workspaceId,
            businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
            ...(sessionId ? { sessionId } : {}),
        };
    }

    /** Headline numbers plus a per-day series for the chart. */
    async summary(workspaceId: string, dto: AnalyticsRangeDto) {
        const { from, to } = await this.range(workspaceId, dto);

        const saleWhere: Prisma.TicketSaleWhereInput = {
            workspaceId,
            status: 'COMPLETED',
            ticketDay: this.dayFilter(workspaceId, from, to, dto.sessionId),
        };

        const [agg, voided, comped, days] = await Promise.all([
            this.prisma.ticketSale.aggregate({
                where: saleWhere,
                _sum: {
                    grossAmount: true, discountAmount: true, netAmount: true, ticketCount: true,
                },
                _count: true,
            }),
            this.prisma.ticketSale.count({
                where: { ...saleWhere, status: 'VOIDED' },
            }),
            this.prisma.ticket.count({
                where: {
                    workspaceId,
                    status: 'ISSUED',
                    netPrice: 0,
                    ticketDay: this.dayFilter(workspaceId, from, to, dto.sessionId),
                },
            }),
            this.prisma.ticketDay.findMany({
                where: this.dayFilter(workspaceId, from, to, dto.sessionId),
                select: {
                    id: true, businessDate: true, status: true,
                    session: { select: { id: true, name: true } },
                },
                orderBy: { businessDate: 'asc' },
            }),
        ]);

        // One grouped query rather than one per day: a 30-day window on a busy
        // gate is otherwise 30 round trips to draw one line.
        const perDay = await this.prisma.ticketSale.groupBy({
            by: ['ticketDayId'],
            where: saleWhere,
            _sum: { netAmount: true, grossAmount: true, discountAmount: true, ticketCount: true },
            _count: { _all: true },
        });
        const byDayId = new Map(perDay.map((r) => [r.ticketDayId, r]));

        const series = days.map((day) => {
            const row = byDayId.get(day.id);
            return {
                businessDate: day.businessDate.toISOString().slice(0, 10),
                sessionName: day.session.name,
                status: day.status,
                saleCount: row?._count._all ?? 0,
                ticketCount: row?._sum.ticketCount ?? 0,
                gross: money(row?._sum.grossAmount),
                discount: money(row?._sum.discountAmount),
                net: money(row?._sum.netAmount),
            };
        });

        const ticketCount = agg._sum.ticketCount ?? 0;
        const net = agg._sum.netAmount ?? ZERO;

        return {
            range: { from, to },
            totals: {
                saleCount: agg._count,
                voidedCount: voided,
                ticketCount,
                compedTicketCount: comped,
                gross: money(agg._sum.grossAmount),
                discount: money(agg._sum.discountAmount),
                net: money(net),
                // The number a manager actually compares night to night.
                averageTicketValue: ticketCount > 0
                    ? net.div(ticketCount).toFixed(4)
                    : '0.0000',
            },
            series,
        };
    }

    /** Which tiers sell, and what each gives away. */
    async byType(workspaceId: string, dto: AnalyticsRangeDto) {
        const { from, to } = await this.range(workspaceId, dto);

        const rows = await this.prisma.ticket.groupBy({
            by: ['ticketTypeId'],
            where: {
                workspaceId,
                status: 'ISSUED',
                ticketDay: this.dayFilter(workspaceId, from, to, dto.sessionId),
            },
            _count: { _all: true },
            _sum: { grossPrice: true, discountAmount: true, netPrice: true },
        });

        const types = await this.prisma.ticketType.findMany({
            where: { id: { in: rows.map((r) => r.ticketTypeId) } },
            select: {
                id: true, name: true, patronClass: true,
                session: { select: { id: true, name: true } },
            },
        });
        const byId = new Map(types.map((t) => [t.id, t]));

        return {
            range: { from, to },
            data: rows
                .map((r) => ({
                    ticketTypeId: r.ticketTypeId,
                    name: byId.get(r.ticketTypeId)?.name ?? 'Deleted tier',
                    patronClass: byId.get(r.ticketTypeId)?.patronClass ?? null,
                    sessionName: byId.get(r.ticketTypeId)?.session.name ?? null,
                    count: r._count._all,
                    gross: money(r._sum.grossPrice),
                    discount: money(r._sum.discountAmount),
                    net: money(r._sum.netPrice),
                }))
                .sort((a, b) => b.count - a.count),
        };
    }

    /** Who is on the gate, and how the drawers came in. */
    async byAttendant(workspaceId: string, dto: AnalyticsRangeDto) {
        const { from, to } = await this.range(workspaceId, dto);

        const [sales, shifts] = await Promise.all([
            this.prisma.ticketSale.groupBy({
                by: ['soldById'],
                where: {
                    workspaceId,
                    status: 'COMPLETED',
                    ticketDay: this.dayFilter(workspaceId, from, to, dto.sessionId),
                },
                _sum: { netAmount: true, ticketCount: true },
                _count: { _all: true },
            }),
            this.prisma.ticketShift.findMany({
                where: {
                    workspaceId,
                    status: 'CLOSED',
                    ticketDay: this.dayFilter(workspaceId, from, to, dto.sessionId),
                },
                select: { attendantId: true, variance: true },
            }),
        ]);

        const voided = await this.prisma.ticketSale.groupBy({
            by: ['soldById'],
            where: {
                workspaceId,
                status: 'VOIDED',
                ticketDay: this.dayFilter(workspaceId, from, to, dto.sessionId),
            },
            _count: { _all: true },
        });
        const voidsBy = new Map(voided.map((v) => [v.soldById, v._count._all]));

        // Cumulative variance per attendant. A run of small shortfalls is the
        // signal worth surfacing; a single one is usually just a miscount.
        const varianceBy = new Map<string, { total: Decimal; shifts: number }>();
        for (const shift of shifts) {
            const acc = varianceBy.get(shift.attendantId) ?? { total: ZERO, shifts: 0 };
            acc.total = acc.total.add(shift.variance ?? ZERO);
            acc.shifts += 1;
            varianceBy.set(shift.attendantId, acc);
        }

        const users = await this.prisma.user.findMany({
            where: {
                id: { in: [...new Set([...sales.map((s) => s.soldById), ...varianceBy.keys()])] },
            },
            select: { id: true, firstName: true, lastName: true },
        });
        const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

        return {
            range: { from, to },
            data: sales
                .map((row) => {
                    const variance = varianceBy.get(row.soldById);
                    return {
                        userId: row.soldById,
                        name: nameById.get(row.soldById) ?? 'Unknown',
                        saleCount: row._count._all,
                        voidedCount: voidsBy.get(row.soldById) ?? 0,
                        ticketCount: row._sum.ticketCount ?? 0,
                        net: money(row._sum.netAmount),
                        shiftsClosed: variance?.shifts ?? 0,
                        cumulativeVariance: money(variance?.total),
                    };
                })
                .sort((a, b) => Number(b.net) - Number(a.net)),
        };
    }

    /** Whether the loyalty programme is earning its discount. */
    async memberships(workspaceId: string, dto: AnalyticsRangeDto) {
        const { from, to } = await this.range(workspaceId, dto);
        const dayFilter = this.dayFilter(workspaceId, from, to, dto.sessionId);

        const [usage, tiers, active, expiringSoon] = await Promise.all([
            this.prisma.membershipUsage.aggregate({
                where: { ticketDay: dayFilter },
                _sum: { discountAmount: true, ticketCount: true },
                _count: true,
            }),
            this.prisma.membership.groupBy({
                by: ['tierId'],
                where: { workspaceId },
                _count: { _all: true },
            }),
            this.prisma.membership.count({ where: { workspaceId, status: 'ACTIVE' } }),
            this.prisma.membership.count({
                where: {
                    workspaceId,
                    status: 'ACTIVE',
                    validUntil: {
                        gte: new Date(),
                        lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    },
                },
            }),
        ]);

        const tierRows = await this.prisma.membershipTier.findMany({
            where: { id: { in: tiers.map((t) => t.tierId) } },
            select: { id: true, name: true },
        });
        const tierName = new Map(tierRows.map((t) => [t.id, t.name]));

        const salesWithMember = await this.prisma.ticketSale.aggregate({
            where: {
                workspaceId, status: 'COMPLETED',
                membershipId: { not: null },
                ticketDay: dayFilter,
            },
            _sum: { netAmount: true },
            _count: true,
        });

        return {
            range: { from, to },
            totals: {
                activeMembers: active,
                expiringWithin30Days: expiringSoon,
                redemptions: usage._count,
                ticketsDiscounted: usage._sum.ticketCount ?? 0,
                discountGiven: money(usage._sum.discountAmount),
                memberSaleCount: salesWithMember._count,
                memberRevenue: money(salesWithMember._sum.netAmount),
            },
            byTier: tiers.map((t) => ({
                tierId: t.tierId,
                name: tierName.get(t.tierId) ?? 'Deleted tier',
                memberCount: t._count._all,
            })),
        };
    }
}
