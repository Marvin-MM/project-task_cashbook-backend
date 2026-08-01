/**
 * Fiscal period locking.
 *
 * Closing a period is what makes "the books are final" true rather than
 * aspirational: once closed, nothing may be posted into it, and reversals of
 * entries inside it land at the current date instead.
 */
import { FiscalPeriodStatus, Prisma } from '@prisma/client';
import { AppError } from '../errors/AppError';

/**
 * Throw if `entryDate` falls inside a closed period.
 *
 * Called from every posting path. Kept here rather than inside PostingService
 * so that a caller can decide to shift the date instead of failing — which is
 * exactly what reversals do.
 */
export async function assertPeriodOpen(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    entryDate: Date,
): Promise<void> {
    const closed = await tx.fiscalPeriod.findFirst({
        where: {
            workspaceId,
            status: FiscalPeriodStatus.CLOSED,
            startDate: { lte: entryDate },
            endDate: { gte: entryDate },
        },
        select: { startDate: true, endDate: true },
    });

    if (closed) {
        const from = closed.startDate.toISOString().slice(0, 10);
        const to = closed.endDate.toISOString().slice(0, 10);
        throw new AppError(
            `The period ${from} – ${to} is closed. Post to an open period, or reopen it first.`,
            400,
            'PERIOD_CLOSED',
        );
    }
}

/**
 * The date a reversal should carry.
 *
 * While the original's period is open, reverse on the original's date so the
 * correction nets out where it belongs. Once closed, reverse today — posting
 * into closed books is the thing closing exists to prevent.
 */
export async function resolveReversalDate(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    originalDate: Date,
): Promise<Date> {
    const closed = await tx.fiscalPeriod.findFirst({
        where: {
            workspaceId,
            status: FiscalPeriodStatus.CLOSED,
            startDate: { lte: originalDate },
            endDate: { gte: originalDate },
        },
        select: { id: true },
    });

    return closed ? new Date() : originalDate;
}

/** True when the date is inside a closed period. */
export async function isPeriodClosed(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    date: Date,
): Promise<boolean> {
    const closed = await tx.fiscalPeriod.findFirst({
        where: {
            workspaceId,
            status: FiscalPeriodStatus.CLOSED,
            startDate: { lte: date },
            endDate: { gte: date },
        },
        select: { id: true },
    });
    return Boolean(closed);
}
