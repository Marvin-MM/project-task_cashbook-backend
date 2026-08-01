import { z } from 'zod';
import {
    ApprovalStatus,
    AttendanceFlagStatus,
    GeofenceEnforcement,
    LeaveDayPortion,
    OvertimeRequestType,
    PresenceStatus,
    WorkReportPeriod,
} from '@prisma/client';

/** HH:MM, 24-hour. */
const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM in 24-hour form');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const attendanceSettingsPatchSchema = z.object({
    /**
     * Minutes past local midnight where a business day starts. Set to e.g. 240
     * so a night shift is not split across two dates.
     */
    dayBoundaryMinutes: z.coerce.number().int().min(0).max(1439).optional(),
    geofenceEnforcement: z.nativeEnum(GeofenceEnforcement).optional(),
    allowTaskSiteClockIn: z.boolean().optional(),
    overtimeTrackingEnabled: z.boolean().optional(),
    billableTrackingEnabled: z.boolean().optional(),
    wrapUpReminderMinutes: z.coerce.number().int().min(0).max(240).optional(),
    earlyClockOutRequiresReason: z.boolean().optional(),
    allowClockInWhileOnLeave: z.boolean().optional(),
    flagsEnabled: z.boolean().optional(),
    presenceVisibleToAllMembers: z.boolean().optional(),
});

export const createSiteSchema = z.object({
    name: z.string().min(1).max(200),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    radiusMeters: z.coerce.number().int().min(25).max(100000),
    isPrimary: z.boolean().optional(),
    /** Attach the site to a task, so its assignees can clock in from the job. */
    taskId: z.string().uuid().optional(),
});

export const updateSiteSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    radiusMeters: z.coerce.number().int().min(25).max(100000).optional(),
    isPrimary: z.boolean().optional(),
    isActive: z.boolean().optional(),
});

export const createScheduleSchema = z.object({
    /** Omit for the organisation default everyone inherits. */
    userId: z.string().uuid().optional(),
    name: z.string().max(100).optional(),
    workingDays: z.array(z.coerce.number().int().min(1).max(7)).min(1).max(7),
    startTime: wallTime,
    endTime: wallTime,
    graceMinutes: z.coerce.number().int().min(0).max(240).optional(),
    earlyOutGraceMinutes: z.coerce.number().int().min(0).max(240).optional(),
    breakMinutes: z.coerce.number().int().min(0).max(480).optional(),
    breakPaid: z.boolean().optional(),
    expectedMinutesPerDay: z.coerce.number().int().min(1).max(1440),
    clockInWindowStart: wallTime.nullable().optional(),
    clockInWindowEnd: wallTime.nullable().optional(),
    /** Earliest expected clock-out. Advisory — there is no upper bound. */
    clockOutWindowStart: wallTime.nullable().optional(),
    effectiveFrom: isoDate,
});

export const setPresenceSchema = z.object({
    status: z.nativeEnum(PresenceStatus),
    note: z.string().max(200).optional(),
});

export const createHolidaySchema = z.object({
    date: isoDate,
    name: z.string().min(1).max(200),
});

export type AttendanceSettingsPatchDto = z.infer<typeof attendanceSettingsPatchSchema>;
export type CreateSiteDto = z.infer<typeof createSiteSchema>;
export type UpdateSiteDto = z.infer<typeof updateSiteSchema>;
export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;
export type SetPresenceDto = z.infer<typeof setPresenceSchema>;
export type CreateHolidayDto = z.infer<typeof createHolidaySchema>;

// ─── Leave ────────────────────────────────────────────────

const leavePortion = z.nativeEnum(LeaveDayPortion);

export const createLeaveRequestSchema = z.object({
    leaveTypeId: z.string().uuid(),
    startDate: isoDate,
    endDate: isoDate,
    /** Half-days only make sense at the ends of a range. */
    startPortion: leavePortion.optional(),
    endPortion: leavePortion.optional(),
    reason: z.string().min(1, 'Say why').max(1000),
});

export const reviewLeaveSchema = z.object({
    approve: z.boolean(),
    /** Required when declining — checked in the service, where `approve` is known. */
    reviewNote: z.string().max(1000).optional(),
});

export const leaveQuerySchema = z.object({
    status: z.nativeEnum(ApprovalStatus).optional(),
    mine: z.coerce.boolean().optional(),
    userId: z.string().uuid().optional(),
});

// ─── Overtime ─────────────────────────────────────────────

export const createOvertimeRequestSchema = z.object({
    businessDate: isoDate,
    type: z.nativeEnum(OvertimeRequestType).optional(),
    requestedMinutes: z.coerce.number().int().min(1).max(960),
    reason: z.string().min(1).max(1000),
});

export const reviewOvertimeSchema = z.object({
    approve: z.boolean(),
    /** Grant part of it. Omit to grant what was asked for. */
    approvedMinutes: z.coerce.number().int().min(0).max(960).optional(),
    reviewNote: z.string().max(1000).optional(),
});

// ─── Work reports ─────────────────────────────────────────

export const submitWorkReportSchema = z.object({
    period: z.nativeEnum(WorkReportPeriod),
    /** First day of the period; the end is derived from the period type. */
    periodStart: isoDate,
    summary: z.string().min(1, 'Say what you did').max(5000),
    blockers: z.string().max(2000).optional(),
    nextSteps: z.string().max(2000).optional(),
});

export const reviewWorkReportSchema = z.object({
    approve: z.boolean(),
    reviewNote: z.string().max(2000).optional(),
});

export const workReportQuerySchema = z.object({
    period: z.nativeEnum(WorkReportPeriod).optional(),
    status: z.nativeEnum(ApprovalStatus).optional(),
    mine: z.coerce.boolean().optional(),
});

// ─── Flags ────────────────────────────────────────────────

export const waiveFlagSchema = z.object({
    /** Never optional: a waiver with no reason is an unexplained erasure. */
    reason: z.string().min(1, 'Say why this is being waived').max(1000),
});

export const flagQuerySchema = z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    userId: z.string().uuid().optional(),
    status: z.nativeEnum(AttendanceFlagStatus).optional(),
});

export type CreateLeaveRequestDto = z.infer<typeof createLeaveRequestSchema>;
export type ReviewLeaveDto = z.infer<typeof reviewLeaveSchema>;
export type CreateOvertimeRequestDto = z.infer<typeof createOvertimeRequestSchema>;
export type ReviewOvertimeDto = z.infer<typeof reviewOvertimeSchema>;
export type SubmitWorkReportDto = z.infer<typeof submitWorkReportSchema>;
export type ReviewWorkReportDto = z.infer<typeof reviewWorkReportSchema>;
export type WaiveFlagDto = z.infer<typeof waiveFlagSchema>;
