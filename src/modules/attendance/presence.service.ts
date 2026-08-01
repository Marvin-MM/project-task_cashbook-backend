/**
 * What someone is doing while they are clocked in.
 *
 * Stored as intervals rather than a single current value, because BREAK and
 * LUNCH minutes are subtracted from worked time when the schedule says breaks
 * are unpaid — that needs durations. `WorkSession.presenceStatus` is a cache of
 * the open interval so the "who is around" view is one query.
 *
 * Presence is self-reported and only the subject may set it. Letting a manager
 * write it would make it a claim about somebody rather than by them, at which
 * point it stops meaning anything.
 */
import { injectable, inject } from 'tsyringe';
import { PresenceStatus, PrismaClient, Prisma } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../core/errors/AppError';
import { WorkspaceClock } from '../../core/time/workspace-clock';

@injectable()
export class PresenceService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    /**
     * Open the first interval, as part of clocking in.
     *
     * Everyone starts AVAILABLE; changing it is a deliberate act.
     */
    async openInitialInterval(
        tx: Prisma.TransactionClient,
        session: { id: string; workspaceId: string; userId: string; clockIn: Date },
    ) {
        await tx.workSessionPresence.create({
            data: {
                sessionId: session.id,
                workspaceId: session.workspaceId,
                userId: session.userId,
                status: PresenceStatus.AVAILABLE,
                startedAt: session.clockIn,
            },
        });
    }

    /**
     * Close the open interval as part of clocking out, and report how many
     * minutes were unpaid break.
     *
     * Returns the figure rather than writing it so the caller can put it in the
     * same UPDATE that closes the session — two writes would leave a window
     * where the session is closed but its break minutes are still zero.
     */
    async closeIntervals(
        tx: Prisma.TransactionClient,
        sessionId: string,
        endedAt: Date,
        breakPaid: boolean,
    ): Promise<{ breakMinutes: number }> {
        const open = await tx.workSessionPresence.findFirst({
            where: { sessionId, endedAt: null },
        });
        if (open) {
            await tx.workSessionPresence.update({
                where: { id: open.id },
                data: {
                    endedAt,
                    minutes: WorkspaceClock.minutesBetween(open.startedAt, endedAt),
                },
            });
        }

        if (breakPaid) return { breakMinutes: 0 };

        const intervals = await tx.workSessionPresence.findMany({
            where: {
                sessionId,
                status: { in: [PresenceStatus.BREAK, PresenceStatus.LUNCH] },
            },
            select: { minutes: true },
        });
        return {
            breakMinutes: intervals.reduce((total, i) => total + (i.minutes ?? 0), 0),
        };
    }

    /**
     * Change your own status.
     *
     * Only legal while clocked in — the whole point is to tell colleagues
     * whether you are reachable right now, and someone who has gone home is
     * not. An unchanged status is a no-op rather than a zero-length interval.
     */
    async setPresence(
        workspaceId: string,
        userId: string,
        status: PresenceStatus,
        note?: string,
    ) {
        const session = await this.prisma.workSession.findFirst({
            where: { workspaceId, userId, clockOut: null },
            select: { id: true, presenceStatus: true },
        });
        if (!session) {
            throw new ConflictError('You are not clocked in, so there is no status to set.');
        }
        if (session.presenceStatus === status) return session;

        const at = new Date();

        try {
            return await this.prisma.$transaction(async (tx) => {
                const open = await tx.workSessionPresence.findFirst({
                    where: { sessionId: session.id, endedAt: null },
                });
                if (open) {
                    await tx.workSessionPresence.update({
                        where: { id: open.id },
                        data: {
                            endedAt: at,
                            minutes: WorkspaceClock.minutesBetween(open.startedAt, at),
                        },
                    });
                }
                await tx.workSessionPresence.create({
                    data: {
                        sessionId: session.id,
                        workspaceId,
                        userId,
                        status,
                        startedAt: at,
                        note: note ?? null,
                    },
                });

                // Conditional on the session still being open: a clock-out
                // racing this must not be undone by writing presence back onto
                // a closed session, which the CHECK would reject anyway.
                const updated = await tx.workSession.updateMany({
                    where: { id: session.id, clockOut: null },
                    data: { presenceStatus: status, presenceChangedAt: at },
                });
                if (updated.count === 0) {
                    throw new ConflictError('You were clocked out while changing your status.');
                }

                return tx.workSession.findUniqueOrThrow({ where: { id: session.id } });
            });
        } catch (error: any) {
            // presence_one_open_per_session — two changes landed together. The
            // state has already converged; the loser just reports the winner's.
            if (error?.code === 'P2002') {
                return this.prisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
            }
            throw error;
        }
    }

    /** The presence timeline for one session. */
    async getTimeline(sessionId: string, workspaceId: string) {
        const session = await this.prisma.workSession.findUnique({
            where: { id: sessionId },
            select: { workspaceId: true },
        });
        if (!session || session.workspaceId !== workspaceId) {
            throw new NotFoundError('Work session');
        }
        return this.prisma.workSessionPresence.findMany({
            where: { sessionId },
            orderBy: { startedAt: 'asc' },
        });
    }
}
