import { z } from 'zod';
import { TimeEntrySource } from '@prisma/client';

// ─── Time Entry ───────────────────────────────────────
export const createTimeEntrySchema = z.object({
    taskId: z.string().uuid('Invalid task ID').optional().nullable(),
    projectId: z.string().uuid('Invalid project ID').optional().nullable(),
    startTime: z.string().datetime({ offset: true }),
    endTime: z.string().datetime({ offset: true }).optional().nullable(),
    description: z.string().max(1000).optional(),
    source: z.nativeEnum(TimeEntrySource).default(TimeEntrySource.MANUAL),
}).refine(
    (d) => d.taskId || d.projectId,
    { message: 'Either taskId or projectId is required', path: ['taskId'] },
);

export const updateTimeEntrySchema = z.object({
    description: z.string().max(1000).optional().nullable(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional().nullable(),
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
});

export const clockOutSchema = z.object({
    description: z.string().max(500).optional().nullable(),
});

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
export type TimeEntryQueryDto = z.infer<typeof timeEntryQuerySchema>;
export type WorkSessionQueryDto = z.infer<typeof workSessionQuerySchema>;
