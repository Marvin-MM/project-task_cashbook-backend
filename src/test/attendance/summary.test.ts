/**
 * The period summary, now computed in SQL.
 *
 * It used to pull every matching row into memory and bucket them with a JS Map,
 * keyed on `startTime.toISOString().slice(0, 10)` — a UTC slice. Under Kampala
 * (+03:00) a 22:30 UTC entry is 01:30 the *next* local day, so evening work was
 * filed under the wrong date. Grouping on the stored `business_date` is what
 * fixes it, and these tests pin that.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceRole } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { TimeTrackingService } from '../../modules/time-tracking/time-tracking.service';
import { addWorkspaceMember, createProject, createUser, createWorkspace } from '../factories';
import { clearClockCache, toDateColumn } from '../../core/time/workspace-clock';

const service = () => resolveService(TimeTrackingService);

async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id, { timezone: 'Africa/Kampala' });
    const member = await createUser();
    await addWorkspaceMember(workspace.id, member.id, WorkspaceRole.MEMBER);
    const project = await createProject(workspace.id, owner.id, { name: 'Acme rebuild' });
    return { owner, workspace, member, project };
}

/** A finished entry, with its business date stated explicitly. */
async function entry(opts: {
    workspaceId: string;
    userId: string;
    projectId?: string;
    businessDate: string;
    minutes: number;
    billable?: boolean;
    startUtc?: string;
}) {
    const start = new Date(opts.startUtc ?? `${opts.businessDate}T08:00:00.000Z`);
    return testPrisma.timeEntry.create({
        data: {
            workspaceId: opts.workspaceId,
            userId: opts.userId,
            createdById: opts.userId,
            projectId: opts.projectId ?? null,
            startTime: start,
            endTime: new Date(start.getTime() + opts.minutes * 60_000),
            durationMinutes: opts.minutes,
            businessDate: toDateColumn(opts.businessDate),
            billable: opts.billable ?? true,
            source: 'MANUAL',
        },
    });
}

beforeEach(async () => {
    await resetDatabase();
    clearClockCache();
});

describe('totals', () => {
    it('adds up minutes and splits billable from the rest', async () => {
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 120 });
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 60, billable: false });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'day',
        } as any);

        expect(summary.totalMinutes).toBe(180);
        expect(summary.billableMinutes).toBe(120);
        expect(summary.nonBillableMinutes).toBe(60);
        expect(summary.entryCount).toBe(2);
    });

    it('keeps the grand total consistent with the buckets beneath it', async () => {
        // GROUPING SETS computes both in one pass, so they cannot disagree.
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 120 });
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-11', minutes: 90 });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'day',
        } as any);

        const summed = summary.groups.reduce((total, group) => total + group.minutes, 0);
        expect(summed).toBe(summary.totalMinutes);
    });
});

describe('day bucketing', () => {
    it('files late-evening UTC work under the local day it belongs to', async () => {
        // 22:30Z on the 10th is 01:30 on the 11th in Kampala. The old UTC slice
        // put this on the 10th.
        const f = await fixture();
        await entry({
            workspaceId: f.workspace.id,
            userId: f.owner.id,
            businessDate: '2026-03-11',
            startUtc: '2026-03-10T22:30:00.000Z',
            minutes: 60,
        });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'day',
        } as any);

        expect(summary.groups).toHaveLength(1);
        expect(summary.groups[0].key).toBe('2026-03-11');
        expect(summary.groups[0].key).not.toBe('2026-03-10');
    });

    it('filters the range on the business date too', async () => {
        const f = await fixture();
        await entry({
            workspaceId: f.workspace.id,
            userId: f.owner.id,
            businessDate: '2026-03-11',
            startUtc: '2026-03-10T22:30:00.000Z',
            minutes: 60,
        });

        // Asking for the 11th finds it, even though it started on the 10th UTC.
        const inRange = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'day', dateFrom: '2026-03-11', dateTo: '2026-03-11',
        } as any);
        expect(inRange.totalMinutes).toBe(60);

        const outOfRange = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'day', dateFrom: '2026-03-10', dateTo: '2026-03-10',
        } as any);
        expect(outOfRange.totalMinutes).toBe(0);
    });
});

describe('grouping', () => {
    it('labels projects by name rather than id', async () => {
        const f = await fixture();
        await entry({
            workspaceId: f.workspace.id, userId: f.owner.id,
            projectId: f.project.id, businessDate: '2026-03-10', minutes: 120,
        });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'project',
        } as any);

        expect(summary.groups[0].label).toBe('Acme rebuild');
    });

    it('labels people by name', async () => {
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 60 });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'user',
        } as any);

        expect(summary.groups[0].label).toBe('Test User');
    });

    it('calls time with no project "Unassigned" rather than dropping it', async () => {
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 45 });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'project',
        } as any);

        expect(summary.groups[0].label).toBe('Unassigned');
        expect(summary.totalMinutes).toBe(45);
    });
});

describe('scoping', () => {
    it('shows a plain member only their own time', async () => {
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 300 });
        await entry({ workspaceId: f.workspace.id, userId: f.member.id, businessDate: '2026-03-10', minutes: 60 });

        const summary = await service().getTimeSummary(f.workspace.id, f.member.id, {
            groupBy: 'day',
        } as any);

        expect(summary.totalMinutes).toBe(60);
    });

    it('ignores a userId filter from somebody who cannot see other people', async () => {
        // Otherwise the filter becomes a way to read a colleague's hours.
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 300 });

        const summary = await service().getTimeSummary(f.workspace.id, f.member.id, {
            groupBy: 'day', userId: f.owner.id,
        } as any);

        expect(summary.totalMinutes).toBe(0);
    });

    it('lets an owner see everybody', async () => {
        const f = await fixture();
        await entry({ workspaceId: f.workspace.id, userId: f.owner.id, businessDate: '2026-03-10', minutes: 300 });
        await entry({ workspaceId: f.workspace.id, userId: f.member.id, businessDate: '2026-03-10', minutes: 60 });

        const summary = await service().getTimeSummary(f.workspace.id, f.owner.id, {
            groupBy: 'user',
        } as any);

        expect(summary.totalMinutes).toBe(360);
        expect(summary.groups).toHaveLength(2);
    });
});
