import { Router } from 'express';
import { container } from 'tsyringe';
import { AttendanceController } from './attendance.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import {
    attendanceSettingsPatchSchema,
    createSiteSchema,
    updateSiteSchema,
    createScheduleSchema,
    setPresenceSchema,
    createHolidaySchema,
    createLeaveRequestSchema,
    reviewLeaveSchema,
    leaveQuerySchema,
    createOvertimeRequestSchema,
    reviewOvertimeSchema,
    submitWorkReportSchema,
    reviewWorkReportSchema,
    workReportQuerySchema,
    waiveFlagSchema,
    flagQuerySchema,
} from './attendance.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(AttendanceController);

router.use(authenticate as any);

/*
 * Three tiers, and the distinction matters:
 *
 *   USE_TIME_TRACKING   reading the policy and setting your OWN status. Everyone
 *                       needs the rules that apply to them, and presence is
 *                       self-reported by definition.
 *   VIEW_ALL_ATTENDANCE seeing everyone. The team view is open to all, but the
 *                       service strips location and session detail for callers
 *                       without this — filtered in the query, not the client.
 *   MANAGE_ATTENDANCE   changing the policy. HR and above.
 */

// ─── Settings ─────────────────────────────────────────
router.get('/settings',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.getSettings.bind(controller) as any);

router.patch('/settings',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(attendanceSettingsPatchSchema),
    controller.updateSettings.bind(controller) as any);

// ─── Locations ────────────────────────────────────────
router.get('/sites',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.listSites.bind(controller) as any);

router.post('/sites',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(createSiteSchema),
    controller.createSite.bind(controller) as any);

router.patch('/sites/:siteId',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(uuidParams('siteId'), 'params'),
    validate(updateSiteSchema),
    controller.updateSite.bind(controller) as any);

router.delete('/sites/:siteId',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(uuidParams('siteId'), 'params'),
    controller.deactivateSite.bind(controller) as any);

// ─── Schedules ────────────────────────────────────────
router.get('/schedules',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.listSchedules.bind(controller) as any);

router.post('/schedules',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(createScheduleSchema),
    controller.createSchedule.bind(controller) as any);

// ─── Holidays ─────────────────────────────────────────
router.get('/holidays',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.listHolidays.bind(controller) as any);

router.post('/holidays',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(createHolidaySchema),
    controller.createHoliday.bind(controller) as any);

router.delete('/holidays/:holidayId',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    validate(uuidParams('holidayId'), 'params'),
    controller.deleteHoliday.bind(controller) as any);

// ─── Presence ─────────────────────────────────────────
router.post('/presence',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(setPresenceSchema),
    controller.setPresence.bind(controller) as any);

router.get('/team',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.getTeamStatus.bind(controller) as any);

// ─── Leave ────────────────────────────────────────────
// Anyone may ask; APPROVE_LEAVE decides, checked in the service so the list
// endpoints can narrow to "yours" rather than 403 for everybody else.
router.get('/leave-types',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.listLeaveTypes.bind(controller) as any);

router.get('/leave',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(leaveQuerySchema, 'query'),
    controller.listLeave.bind(controller) as any);

router.post('/leave',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(createLeaveRequestSchema),
    controller.requestLeave.bind(controller) as any);

router.post('/leave/:requestId/review',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('requestId'), 'params'),
    validate(reviewLeaveSchema),
    controller.reviewLeave.bind(controller) as any);

router.post('/leave/:requestId/withdraw',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('requestId'), 'params'),
    controller.withdrawLeave.bind(controller) as any);

router.post('/leave/:requestId/cancel',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('requestId'), 'params'),
    controller.cancelLeave.bind(controller) as any);

// ─── Overtime ─────────────────────────────────────────
router.get('/overtime',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.listOvertime.bind(controller) as any);

router.post('/overtime',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(createOvertimeRequestSchema),
    controller.requestOvertime.bind(controller) as any);

router.post('/overtime/:requestId/review',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('requestId'), 'params'),
    validate(reviewOvertimeSchema),
    controller.reviewOvertime.bind(controller) as any);

// ─── Flags ────────────────────────────────────────────
router.get('/flags',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(flagQuerySchema, 'query'),
    controller.listFlags.bind(controller) as any);

// Owner and admin only — HR owns the policy, so erasing a breach of it should
// not sit with them. Gated at the route as well as in the service.
router.post('/flags/:flagId/waive',
    requireWorkspaceMember(WorkspacePermission.WAIVE_ATTENDANCE_FLAG) as any,
    validate(uuidParams('flagId'), 'params'),
    validate(waiveFlagSchema),
    controller.waiveFlag.bind(controller) as any);

// ─── Work reports ─────────────────────────────────────
router.get('/work-reports',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(workReportQuerySchema, 'query'),
    controller.listWorkReports.bind(controller) as any);

router.post('/work-reports',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(submitWorkReportSchema),
    controller.submitWorkReport.bind(controller) as any);

router.post('/work-reports/:reportId/review',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('reportId'), 'params'),
    validate(reviewWorkReportSchema),
    controller.reviewWorkReport.bind(controller) as any);

// ─── Rollup ───────────────────────────────────────────
router.post('/recompute',
    requireWorkspaceMember(WorkspacePermission.MANAGE_ATTENDANCE) as any,
    controller.recompute.bind(controller) as any);

export default router;
