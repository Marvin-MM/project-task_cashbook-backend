/**
 * Rebuild `attendance_days` from the sessions underneath it.
 *
 * The rollup is derived, so it must always be reproducible — that is the
 * property that makes it trustworthy rather than just another place for numbers
 * to drift. This script is how you exercise it: after a schedule correction,
 * after a backfill, or when somebody asks why a month looks wrong.
 *
 * Deliberately NOT dry-run-by-default, unlike repair-financial-balances.ts.
 * That script guards a dry run because it touches money and a wrong write is
 * expensive. This one recomputes a fully derived table from the rows underneath
 * it: the output is correct by construction, so a "preview" mode would have to
 * write and then roll back, and a --dry-run flag that still writes is worse than
 * no flag at all. It always rebuilds, and reports what changed.
 *
 *   npx tsx scripts/rebuild-attendance-days.ts --from 2026-03-01 --to 2026-03-31
 *   npx tsx scripts/rebuild-attendance-days.ts --workspace <uuid> --from 2026-03-01
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { AttendanceRollupService } from '../src/modules/attendance/rollup.service';
import { clockFor } from '../src/core/time/workspace-clock';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
    const from = arg('from');
    const to = arg('to') ?? from;
    const workspaceFilter = arg('workspace');

    if (!from || !DATE.test(from) || !to || !DATE.test(to)) {
        console.error('Usage: --from YYYY-MM-DD [--to YYYY-MM-DD] [--workspace <uuid>]');
        process.exit(1);
    }
    if (to < from) {
        console.error('--to is before --from');
        process.exit(1);
    }

    const workspaces = await prisma.workspace.findMany({
        where: { isActive: true, ...(workspaceFilter ? { id: workspaceFilter } : {}) },
        select: { id: true, name: true, timezone: true },
    });

    if (workspaces.length === 0) {
        console.error('No matching active workspace');
        process.exit(1);
    }

    console.log(`Rebuilding ${from} to ${to} across ${workspaces.length} workspace(s)\n`);

    const rollup = new AttendanceRollupService(prisma);
    let totalChanged = 0;

    for (const workspace of workspaces) {
        const clock = await clockFor(prisma, workspace.id);

        // Snapshot first, so the output says what actually changed rather than
        // just "done" — which is the difference between a useful repair tool
        // and one you have to check by hand afterwards.
        const before = await prisma.attendanceDay.findMany({
            where: {
                workspaceId: workspace.id,
                businessDate: {
                    gte: new Date(`${from}T00:00:00.000Z`),
                    lte: new Date(`${to}T00:00:00.000Z`),
                },
            },
            select: {
                userId: true, businessDate: true, status: true,
                workedMinutes: true, countedOvertimeMinutes: true, lateMinutes: true,
            },
        });
        const key = (row: { userId: string; businessDate: Date }) =>
            `${row.userId}:${row.businessDate.toISOString().slice(0, 10)}`;
        const previous = new Map(before.map((row) => [key(row), row]));

        let cursor = from;
        let days = 0;
        while (cursor <= to && days < 400) {
            await rollup.recomputeDay(workspace.id, cursor);
            cursor = clock.addLocalDays(cursor, 1);
            days += 1;
        }

        const after = await prisma.attendanceDay.findMany({
            where: {
                workspaceId: workspace.id,
                businessDate: {
                    gte: new Date(`${from}T00:00:00.000Z`),
                    lte: new Date(`${to}T00:00:00.000Z`),
                },
            },
            select: {
                userId: true, businessDate: true, status: true,
                workedMinutes: true, countedOvertimeMinutes: true, lateMinutes: true,
            },
        });

        const changes: string[] = [];
        for (const row of after) {
            const was = previous.get(key(row));
            if (!was) {
                changes.push(`  + ${key(row)} ${row.status} ${row.workedMinutes}m (new)`);
            } else if (
                was.status !== row.status
                || was.workedMinutes !== row.workedMinutes
                || was.countedOvertimeMinutes !== row.countedOvertimeMinutes
                || was.lateMinutes !== row.lateMinutes
            ) {
                changes.push(
                    `  ~ ${key(row)} ${was.status}->${row.status} `
                    + `${was.workedMinutes}m->${row.workedMinutes}m `
                    + `ot ${was.countedOvertimeMinutes}->${row.countedOvertimeMinutes}`,
                );
            }
        }

        if (changes.length > 0) {
            console.log(`${workspace.name} (${workspace.timezone}) — ${changes.length} change(s)`);
            console.log(changes.slice(0, 20).join('\n'));
            if (changes.length > 20) console.log(`  … and ${changes.length - 20} more`);
            console.log('');
        }
        totalChanged += changes.length;
    }

    console.log(
        totalChanged === 0
            ? 'Nothing changed — the rollup already matched the sessions underneath it.'
            : `Rebuilt. ${totalChanged} row(s) changed.`,
    );
}

main()
    .catch((error) => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
