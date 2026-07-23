import { z } from 'zod';
import { TimeEntrySource } from '@prisma/client';

const latitudeSchema = z.coerce.number().min(-90).max(90);
const longitudeSchema = z.coerce.number().min(-180).max(180);

// ─── Time Entry ───────────────────────────────────────
export const createTimeEntrySchema = z.object({
    taskId: z.string().uuid('Invalid task ID').optional().nullable(),
    projectId: z.string().uuid('Invalid project ID').optional().nullable(),
    startTime: z.string().datetime({ offset: true }),
    endTime: z.string().datetime({ offset: true }).optional().nullable(),
    description: z.string().max(1000).optional(),
    source: z.nativeEnum(TimeEntrySource).default(TimeEntrySource.MANUAL),
    billable: z.boolean().optional().default(true),
}).superRefine((d, ctx) => {
    if (!d.taskId && !d.projectId) {
        ctx.addIssue({ code: 'custom', message: 'Either taskId or projectId is required', path: ['taskId'] });
    }
    if (d.source === TimeEntrySource.TIMER) {
        ctx.addIssue({
            code: 'custom',
            message: 'Timer entries must be started through the timer endpoint',
            path: ['source'],
        });
    }
    if (!d.endTime) {
        ctx.addIssue({
            code: 'custom',
            message: 'Manual time entries require an endTime',
            path: ['endTime'],
        });
    }
});

export const updateTimeEntrySchema = z.object({
    description: z.string().max(1000).optional().nullable(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional().nullable(),
    taskId: z.string().uuid('Invalid task ID').optional().nullable(),
    projectId: z.string().uuid('Invalid project ID').optional().nullable(),
    billable: z.boolean().optional(),
});

export const lockTimeEntrySchema = z.object({
    isLocked: z.boolean(),
});

export const timeSummaryQuerySchema = z.object({
    dateFrom: z.string().datetime({ offset: true }).optional(),
    dateTo: z.string().datetime({ offset: true }).optional(),
    groupBy: z.enum(['project', 'user', 'day', 'task']).default('project'),
    userId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    billableOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const startTimerSchema = z.object({
    taskId: z.string().uuid('Invalid task ID').optional().nullable(),
    projectId: z.string().uuid('Invalid project ID').optional().nullable(),
    description: z.string().max(1000).optional(),
}).refine(
    (d) => d.taskId || d.projectId,
    { message: 'Either taskId or projectId is required for a timer', path: ['taskId'] },
);

// ─── Work Session ─────────────────────────────────────
export const clockInSchema = z.object({
    description: z.string().max(500).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    locationLabel: z.string().max(300).optional(),
});

export const clockOutSchema = z.object({
    description: z.string().max(500).optional().nullable(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    locationLabel: z.string().max(300).optional(),
});

export const attendanceSettingsSchema = z.object({
    attendanceLocationName: z.string().trim().max(200).optional().nullable(),
    attendanceLatitude: latitudeSchema.optional().nullable(),
    attendanceLongitude: longitudeSchema.optional().nullable(),
    attendanceRadiusMeters: z.coerce.number().int().min(25).max(10000).optional().nullable(),
}).superRefine((d, ctx) => {
    const hasAnyLocation =
        d.attendanceLatitude !== undefined ||
        d.attendanceLongitude !== undefined ||
        d.attendanceRadiusMeters !== undefined;
    const hasCompleteLocation =
        d.attendanceLatitude != null &&
        d.attendanceLongitude != null &&
        d.attendanceRadiusMeters != null;
    const isClearing =
        d.attendanceLatitude === null &&
        d.attendanceLongitude === null &&
        d.attendanceRadiusMeters === null;

    if (hasAnyLocation && !hasCompleteLocation && !isClearing) {
        ctx.addIssue({
            code: 'custom',
            message: 'attendanceLatitude, attendanceLongitude, and attendanceRadiusMeters must be set together',
            path: ['attendanceLatitude'],
        });
    }
});

const workSessionAdjustmentBase = z.object({
    userId: z.string().uuid('Invalid user ID'),
    clockIn: z.string().datetime({ offset: true }),
    clockOut: z.string().datetime({ offset: true }),
    description: z.string().max(500).optional().nullable(),
    clockInLatitude: latitudeSchema.optional().nullable(),
    clockInLongitude: longitudeSchema.optional().nullable(),
    clockInLocationLabel: z.string().max(300).optional().nullable(),
    clockOutLatitude: latitudeSchema.optional().nullable(),
    clockOutLongitude: longitudeSchema.optional().nullable(),
    clockOutLocationLabel: z.string().max(300).optional().nullable(),
    adjustmentReason: z.string().trim().min(3).max(1000),
});

export const createWorkSessionSchema = workSessionAdjustmentBase.refine(
    (d) => new Date(d.clockOut) > new Date(d.clockIn),
    { message: 'clockOut must be after clockIn', path: ['clockOut'] },
);

export const updateWorkSessionSchema = workSessionAdjustmentBase
    .partial()
    .extend({
        userId: z.string().uuid('Invalid user ID').optional(),
        adjustmentReason: z.string().trim().min(3).max(1000),
    })
    .refine(
        (d) => !(d.clockIn && d.clockOut) || new Date(d.clockOut) > new Date(d.clockIn),
        { message: 'clockOut must be after clockIn', path: ['clockOut'] },
    );

// ─── Query ────────────────────────────────────────────
export const timeEntryQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    dateFrom: z.string().datetime({ offset: true }).optional(),
    dateTo: z.string().datetime({ offset: true }).optional(),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const workSessionQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    userId: z.string().uuid().optional(),
    dateFrom: z.string().datetime({ offset: true }).optional(),
    dateTo: z.string().datetime({ offset: true }).optional(),
});

// ─── DTO Types ────────────────────────────────────────
export type CreateTimeEntryDto = z.infer<typeof createTimeEntrySchema>;
export type UpdateTimeEntryDto = z.infer<typeof updateTimeEntrySchema>;
export type StartTimerDto = z.infer<typeof startTimerSchema>;
export type ClockInDto = z.infer<typeof clockInSchema>;
export type ClockOutDto = z.infer<typeof clockOutSchema>;
export type AttendanceSettingsDto = z.infer<typeof attendanceSettingsSchema>;
export type CreateWorkSessionDto = z.infer<typeof createWorkSessionSchema>;
export type UpdateWorkSessionDto = z.infer<typeof updateWorkSessionSchema>;
export type TimeEntryQueryDto = z.infer<typeof timeEntryQuerySchema>;
export type WorkSessionQueryDto = z.infer<typeof workSessionQuerySchema>;
export type LockTimeEntryDto = z.infer<typeof lockTimeEntrySchema>;
export type TimeSummaryQueryDto = z.infer<typeof timeSummaryQuerySchema>;
