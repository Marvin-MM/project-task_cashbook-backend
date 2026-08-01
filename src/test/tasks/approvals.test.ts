/**
 * Task approvals: asking for work, and reporting on it.
 *
 * The two rules being protected:
 *
 *   An assignee cannot reach DONE on their own. They submit a report, which
 *   puts the task in IN_REVIEW, and an approver decides. That single path is
 *   what makes "members report at the end of each task" and "a member-created
 *   task is signed off by a manager" the same mechanism rather than two.
 *
 *   Nobody gets handed more unfinished work than the workspace allows. The
 *   check that matters runs INSIDE the approval transaction, because a member
 *   can queue up requests while free and have them decided much later.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { TasksService } from '../../modules/tasks/tasks.service';
import {
    addProjectMember,
    addWorkspaceMember,
    assignTask,
    createProject,
    createTask,
    createUser,
    createWorkspace,
    getTask,
} from '../factories';
import { WorkspaceRole } from '@prisma/client';

const service = () => resolveService(TasksService);

/** Owner + a project both actors belong to + a task inside it. */
async function fixture(options: { limit?: number | null } = {}) {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    if (options.limit !== undefined) {
        await testPrisma.workspace.update({
            where: { id: workspace.id },
            data: { maxConcurrentOpenTasks: options.limit },
        });
    }
    const member = await createUser();
    await addWorkspaceMember(workspace.id, member.id, WorkspaceRole.MEMBER);

    const project = await createProject(workspace.id, owner.id);
    await addProjectMember(project.id, member.id, 'CONTRIBUTOR');
    const task = await createTask(workspace.id, owner.id, { projectId: project.id });

    return { owner, workspace, member, project, task };
}

beforeEach(async () => {
    await resetDatabase();
});

describe('requesting a task', () => {
    it('lets a project member ask for a task they can see but are not on', async () => {
        const { workspace, member, task } = await fixture();

        const request = await service().requestAssignment(task.id, workspace.id, member.id, {
            message: 'I have done this before',
        });

        expect(request.status).toBe('PENDING');
        expect(request.requesterId).toBe(member.id);
    });

    it('refuses a second live request for the same task', async () => {
        const { workspace, member, task } = await fixture();
        await service().requestAssignment(task.id, workspace.id, member.id, {});

        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses when the caller is already assigned', async () => {
        const { owner, workspace, member, task } = await fixture();
        await assignTask(task.id, member.id, owner.id);

        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).rejects.toThrow(/already assigned/i);
    });

    it('refuses a task in a project the caller does not belong to', async () => {
        const { owner, workspace } = await fixture();
        const outsider = await createUser();
        await addWorkspaceMember(workspace.id, outsider.id, WorkspaceRole.MEMBER);
        const otherProject = await createProject(workspace.id, owner.id);
        const hidden = await createTask(workspace.id, owner.id, { projectId: otherProject.id });

        await expect(
            service().requestAssignment(hidden.id, workspace.id, outsider.id, {}),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets the requester take it back', async () => {
        const { workspace, member, task } = await fixture();
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        const withdrawn = await service().withdrawAssignmentRequest(
            request.id, workspace.id, member.id,
        );

        expect(withdrawn.status).toBe('WITHDRAWN');
        // Withdrawing frees them to ask again — the unique index is partial.
        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).resolves.toBeTruthy();
    });
});

describe('the unfinished-work limit', () => {
    it('blocks a request while the member still has an open task', async () => {
        const { owner, workspace, member, project, task } = await fixture({ limit: 1 });
        const busy = await createTask(workspace.id, owner.id, { projectId: project.id });
        await assignTask(busy.id, member.id, owner.id);

        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).rejects.toThrow(/unfinished work/i);
    });

    it('does not count a task that is already DONE', async () => {
        const { owner, workspace, member, project, task } = await fixture({ limit: 1 });
        const finished = await createTask(workspace.id, owner.id, {
            projectId: project.id, status: 'DONE',
        });
        await assignTask(finished.id, member.id, owner.id);

        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).resolves.toBeTruthy();
    });

    it('DOES count a task still in review — the work can come back', async () => {
        const { owner, workspace, member, project, task } = await fixture({ limit: 1 });
        const underReview = await createTask(workspace.id, owner.id, {
            projectId: project.id, status: 'IN_REVIEW',
        });
        await assignTask(underReview.id, member.id, owner.id);

        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).rejects.toThrow(/unfinished work/i);
    });

    it('is re-checked at approval, not only when asking', async () => {
        // The case the second check exists for: ask while free, pick up other
        // work, then have the old request approved.
        const { owner, workspace, member, project, task } = await fixture({ limit: 1 });
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        const other = await createTask(workspace.id, owner.id, { projectId: project.id });
        await assignTask(other.id, member.id, owner.id);

        await expect(
            service().reviewAssignmentRequest(request.id, workspace.id, owner.id, { approve: true }),
        ).rejects.toThrow(/unfinished work/i);

        // And the request is not left half-decided.
        const after = await testPrisma.taskAssignmentRequest.findUniqueOrThrow({
            where: { id: request.id },
        });
        expect(after.status).toBe('PENDING');
        expect(
            await testPrisma.taskAssignment.count({ where: { taskId: task.id, userId: member.id } }),
        ).toBe(0);
    });

    it('lets a workspace opt out entirely with a null limit', async () => {
        const { owner, workspace, member, project, task } = await fixture({ limit: null });
        const busy = await createTask(workspace.id, owner.id, { projectId: project.id });
        await assignTask(busy.id, member.id, owner.id);

        await expect(
            service().requestAssignment(task.id, workspace.id, member.id, {}),
        ).resolves.toBeTruthy();
    });
});

describe('deciding a request', () => {
    it('assigns the requester on approval', async () => {
        const { owner, workspace, member, task } = await fixture();
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        const decided = await service().reviewAssignmentRequest(
            request.id, workspace.id, owner.id, { approve: true },
        );

        expect(decided.status).toBe('APPROVED');
        expect(decided.reviewerId).toBe(owner.id);
        expect(
            await testPrisma.taskAssignment.count({ where: { taskId: task.id, userId: member.id } }),
        ).toBe(1);
    });

    it('assigns nobody on rejection', async () => {
        const { owner, workspace, member, task } = await fixture();
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        await service().reviewAssignmentRequest(request.id, workspace.id, owner.id, {
            approve: false, reviewNote: 'Someone else is on it',
        });

        expect(
            await testPrisma.taskAssignment.count({ where: { taskId: task.id } }),
        ).toBe(0);
    });

    it('lets exactly one of two simultaneous approvals win', async () => {
        const { owner, workspace, member, task } = await fixture({ limit: null });
        const admin = await createUser();
        await addWorkspaceMember(workspace.id, admin.id, WorkspaceRole.ADMIN);
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        const results = await Promise.allSettled([
            service().reviewAssignmentRequest(request.id, workspace.id, owner.id, { approve: true }),
            service().reviewAssignmentRequest(request.id, workspace.id, admin.id, { approve: false }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        // And the assignment table agrees with whichever decision won.
        const decided = await testPrisma.taskAssignmentRequest.findUniqueOrThrow({
            where: { id: request.id },
        });
        const assignments = await testPrisma.taskAssignment.count({ where: { taskId: task.id } });
        expect(assignments).toBe(decided.status === 'APPROVED' ? 1 : 0);
    });

    it('refuses a plain member as the reviewer', async () => {
        const { workspace, member, task } = await fixture();
        const other = await createUser();
        await addWorkspaceMember(workspace.id, other.id, WorkspaceRole.MEMBER);
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        await expect(
            service().reviewAssignmentRequest(request.id, workspace.id, other.id, { approve: true }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets a delegated project manager decide, even as a plain member', async () => {
        // The per-project PROJECT_MANAGER role, distinct from the workspace one.
        const { workspace, member, project, task } = await fixture();
        const lead = await createUser();
        await addWorkspaceMember(workspace.id, lead.id, WorkspaceRole.MEMBER);
        await addProjectMember(project.id, lead.id, 'PROJECT_MANAGER');
        const request = await service().requestAssignment(task.id, workspace.id, member.id, {});

        await expect(
            service().reviewAssignmentRequest(request.id, workspace.id, lead.id, { approve: true }),
        ).resolves.toMatchObject({ status: 'APPROVED' });
    });
});

describe('the end-of-task report', () => {
    async function assigned() {
        const f = await fixture({ limit: null });
        await assignTask(f.task.id, f.member.id, f.owner.id);
        return f;
    }

    it('moves the task to IN_REVIEW', async () => {
        const { workspace, member, task } = await assigned();

        const report = await service().submitReport(task.id, workspace.id, member.id, {
            summary: 'Rewired the panel and tested it',
        });

        expect(report.status).toBe('PENDING');
        expect((await getTask(task.id)).status).toBe('IN_REVIEW');
    });

    it('refuses a report from someone not assigned', async () => {
        const { workspace, task } = await assigned();
        const bystander = await createUser();
        await addWorkspaceMember(workspace.id, bystander.id, WorkspaceRole.MEMBER);

        await expect(
            service().submitReport(task.id, workspace.id, bystander.id, { summary: 'x' }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses a second report while one is awaiting review', async () => {
        const { workspace, member, task } = await assigned();
        await service().submitReport(task.id, workspace.id, member.id, { summary: 'first' });

        await expect(
            service().submitReport(task.id, workspace.id, member.id, { summary: 'second' }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('marks the task DONE on approval', async () => {
        const { owner, workspace, member, task } = await assigned();
        const report = await service().submitReport(task.id, workspace.id, member.id, {
            summary: 'all finished',
        });

        await service().reviewReport(report.id, workspace.id, owner.id, { approve: true });

        const after = await getTask(task.id);
        expect(after.status).toBe('DONE');
        expect(after.completedAt).not.toBeNull();
    });

    it('sends the task back to IN_PROGRESS on rejection, and allows a resubmission', async () => {
        const { owner, workspace, member, task } = await assigned();
        const report = await service().submitReport(task.id, workspace.id, member.id, {
            summary: 'done I think',
        });

        await service().reviewReport(report.id, workspace.id, owner.id, {
            approve: false, reviewNote: 'The second panel is untested',
        });

        expect((await getTask(task.id)).status).toBe('IN_PROGRESS');
        // A rejected report is history and must not block trying again.
        await expect(
            service().submitReport(task.id, workspace.id, member.id, { summary: 'now really done' }),
        ).resolves.toBeTruthy();
    });

    it('requires a reason when sending a report back', async () => {
        const { owner, workspace, member, task } = await assigned();
        const report = await service().submitReport(task.id, workspace.id, member.id, {
            summary: 'done',
        });

        await expect(
            service().reviewReport(report.id, workspace.id, owner.id, { approve: false }),
        ).rejects.toMatchObject({ code: 'REVIEW_NOTE_REQUIRED' });
    });

    it('lets exactly one of two simultaneous reviews win', async () => {
        const { owner, workspace, member, task } = await assigned();
        const admin = await createUser();
        await addWorkspaceMember(workspace.id, admin.id, WorkspaceRole.ADMIN);
        const report = await service().submitReport(task.id, workspace.id, member.id, {
            summary: 'done',
        });

        const results = await Promise.allSettled([
            service().reviewReport(report.id, workspace.id, owner.id, { approve: true }),
            service().reviewReport(report.id, workspace.id, admin.id, {
                approve: false, reviewNote: 'not yet',
            }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const decided = await testPrisma.taskReport.findUniqueOrThrow({ where: { id: report.id } });
        expect((await getTask(task.id)).status)
            .toBe(decided.status === 'APPROVED' ? 'DONE' : 'IN_PROGRESS');
    });
});

describe('status transitions', () => {
    async function assigned() {
        const f = await fixture({ limit: null });
        await assignTask(f.task.id, f.member.id, f.owner.id);
        return f;
    }

    it('stops an assignee marking their own work done', async () => {
        const { workspace, member, task } = await assigned();

        await expect(
            service().changeStatus(task.id, workspace.id, member.id, { status: 'DONE' as any }),
        ).rejects.toThrow(/report/i);
    });

    it('lets an assignee move between the working states', async () => {
        const { workspace, member, task } = await assigned();

        await expect(
            service().changeStatus(task.id, workspace.id, member.id, { status: 'IN_PROGRESS' as any }),
        ).resolves.toMatchObject({ status: 'IN_PROGRESS' });
    });

    it('refuses IN_REVIEW as a direct status change', async () => {
        // Otherwise a task could sit in review with no report to decide.
        const { workspace, member, task } = await assigned();

        await expect(
            service().changeStatus(task.id, workspace.id, member.id, { status: 'IN_REVIEW' as any }),
        ).rejects.toMatchObject({ code: 'USE_TASK_REPORT' });
    });

    it('stops an assignee pulling a task back out of review', async () => {
        const { workspace, member, task } = await assigned();
        await service().submitReport(task.id, workspace.id, member.id, { summary: 'done' });

        await expect(
            service().changeStatus(task.id, workspace.id, member.id, { status: 'IN_PROGRESS' as any }),
        ).rejects.toThrow(/awaiting review/i);
    });

    it('still lets a manager set any status directly', async () => {
        // They are the ones who would otherwise have to unpick a mistake.
        const { owner, workspace, task } = await assigned();

        await expect(
            service().changeStatus(task.id, workspace.id, owner.id, { status: 'DONE' as any }),
        ).resolves.toMatchObject({ status: 'DONE' });
    });
});

describe('attachments', () => {
    /** Written straight to the row — uploading needs MinIO. */
    async function attachTo(owner: { taskId?: string; taskReportId?: string }, userId: string) {
        return testPrisma.attachment.create({
            data: {
                ...owner,
                uploadedById: userId,
                fileName: 'evidence.pdf',
                fileSize: 2048,
                mimeType: 'application/pdf',
                s3Key: `test/${Date.now()}.pdf`,
            },
        });
    }

    it('lists files on a task for anyone who can see it', async () => {
        const { workspace, member, task, owner } = await fixture();
        await attachTo({ taskId: task.id }, owner.id);

        const files = await service().listTaskAttachments(task.id, workspace.id, member.id);

        expect(files).toHaveLength(1);
        expect(files[0].fileName).toBe('evidence.pdf');
    });

    it('refuses somebody who cannot see the task', async () => {
        const { owner, workspace } = await fixture();
        const outsider = await createUser();
        await addWorkspaceMember(workspace.id, outsider.id, WorkspaceRole.MEMBER);
        const otherProject = await createProject(workspace.id, owner.id);
        const hidden = await createTask(workspace.id, owner.id, { projectId: otherProject.id });
        await attachTo({ taskId: hidden.id }, owner.id);

        await expect(
            service().listTaskAttachments(hidden.id, workspace.id, outsider.id),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('stops anyone but the author attaching to a report', async () => {
        const f = await fixture({ limit: null });
        await assignTask(f.task.id, f.member.id, f.owner.id);
        const report = await service().submitReport(f.task.id, f.workspace.id, f.member.id, {
            summary: 'done',
        });

        await expect(
            service().attachToReport(report.id, f.workspace.id, f.owner.id, {} as any),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('stops the author attaching once the report has been decided', async () => {
        // A decided report is a record of what was reviewed; adding to it after
        // the fact would change what somebody already signed off.
        const f = await fixture({ limit: null });
        await assignTask(f.task.id, f.member.id, f.owner.id);
        const report = await service().submitReport(f.task.id, f.workspace.id, f.member.id, {
            summary: 'done',
        });
        await service().reviewReport(report.id, f.workspace.id, f.owner.id, { approve: true });

        await expect(
            service().attachToReport(report.id, f.workspace.id, f.member.id, {} as any),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('keeps report files separate from task files', async () => {
        const f = await fixture({ limit: null });
        await assignTask(f.task.id, f.member.id, f.owner.id);
        const report = await service().submitReport(f.task.id, f.workspace.id, f.member.id, {
            summary: 'done',
        });
        await attachTo({ taskId: f.task.id }, f.member.id);
        await attachTo({ taskReportId: report.id }, f.member.id);

        expect(await service().listTaskAttachments(f.task.id, f.workspace.id, f.member.id))
            .toHaveLength(1);
        expect(await service().listReportAttachments(report.id, f.workspace.id, f.member.id))
            .toHaveLength(1);
    });
});
