import { z } from 'zod';
import { TaskStatus, TaskPriority } from '@prisma/client';

// ─── Create / Update ──────────────────────────────────
export const createTaskSchema = z.object({
    title: z.string().min(1, 'Title is required').max(300),
    description: z.string().max(5000).optional(),
    projectId: z.string().uuid('Invalid project ID').optional().nullable(),
    status: z.nativeEnum(TaskStatus).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    dueDate: z.string().datetime({ offset: true }).optional().nullable(),
    estimatedTimeMinutes: z.coerce.number().int().min(1).optional().nullable(),
});

export const updateTaskSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(5000).optional().nullable(),
    projectId: z.string().uuid('Invalid project ID').optional().nullable(),
    status: z.nativeEnum(TaskStatus).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    dueDate: z.string().datetime({ offset: true }).optional().nullable(),
    estimatedTimeMinutes: z.coerce.number().int().min(1).optional().nullable(),
});

export const changeTaskStatusSchema = z.object({
    status: z.nativeEnum(TaskStatus),
});

export const assignTaskSchema = z.object({
    userIds: z.array(z.string().uuid('Invalid user ID')).min(1, 'At least one user ID is required'),
});

// ─── Comments ─────────────────────────────────────────
export const createTaskCommentSchema = z.object({
    body: z.string().min(1, 'Comment is required').max(5000),
});

// ─── Checklist ────────────────────────────────────────
export const createChecklistItemSchema = z.object({
    title: z.string().min(1).max(500),
    position: z.coerce.number().int().min(0).optional(),
});

export const updateChecklistItemSchema = z.object({
    title: z.string().min(1).max(500).optional(),
    isDone: z.boolean().optional(),
    position: z.coerce.number().int().min(0).optional(),
});

// ─── Query ────────────────────────────────────────────
export const taskQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    projectId: z.string().uuid().optional(),
    status: z.nativeEnum(TaskStatus).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    assigneeId: z.string().uuid().optional(),
    isOverdue: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt', 'dueDate', 'priority', 'title']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// ─── DTO Types ────────────────────────────────────────
export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;
export type ChangeTaskStatusDto = z.infer<typeof changeTaskStatusSchema>;
export type AssignTaskDto = z.infer<typeof assignTaskSchema>;
export type TaskQueryDto = z.infer<typeof taskQuerySchema>;
export type CreateTaskCommentDto = z.infer<typeof createTaskCommentSchema>;
export type CreateChecklistItemDto = z.infer<typeof createChecklistItemSchema>;
export type UpdateChecklistItemDto = z.infer<typeof updateChecklistItemSchema>;
