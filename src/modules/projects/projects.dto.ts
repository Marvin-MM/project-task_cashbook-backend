import { z } from 'zod';
import { ProjectRole, ProjectStatus } from '@prisma/client';

// ─── Create / Update ──────────────────────────────────
const projectDatesRefine = (d: { startDate?: string | null; endDate?: string | null }) => {
    if (d.startDate && d.endDate) {
        return new Date(d.endDate) >= new Date(d.startDate);
    }
    return true;
};

const decimalString = z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, 'Must be a valid decimal')
    .optional()
    .nullable();

export const createProjectSchema = z.object({
    name: z.string().min(1, 'Name is required').max(200),
    description: z.string().max(2000).optional(),
    status: z.nativeEnum(ProjectStatus).optional(),
    startDate: z.string().datetime({ offset: true }).optional().nullable(),
    endDate: z.string().datetime({ offset: true }).optional().nullable(),
    contactId: z.string().uuid().optional().nullable(),
    budgetAmount: decimalString,
    currency: z.string().trim().length(3).transform((c) => c.toUpperCase()).optional(),
}).refine(projectDatesRefine, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
});

export const updateProjectSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    status: z.nativeEnum(ProjectStatus).optional(),
    startDate: z.string().datetime({ offset: true }).optional().nullable(),
    endDate: z.string().datetime({ offset: true }).optional().nullable(),
    contactId: z.string().uuid().optional().nullable(),
    budgetAmount: decimalString,
    currency: z.string().trim().length(3).transform((c) => c.toUpperCase()).optional(),
}).refine(projectDatesRefine, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
});

// ─── Members ──────────────────────────────────────────
export const addProjectMemberSchema = z.object({
    userId: z.string().uuid('Invalid user ID'),
    role: z.nativeEnum(ProjectRole).default(ProjectRole.CONTRIBUTOR),
});

export const updateProjectMemberRoleSchema = z.object({
    role: z.nativeEnum(ProjectRole),
});

// ─── Query ────────────────────────────────────────────
export const projectQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.nativeEnum(ProjectStatus).optional(),
    search: z.string().optional(),
    sortBy: z.enum(['name', 'createdAt', 'startDate', 'endDate']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// ─── DTO Types ────────────────────────────────────────
export type CreateProjectDto = z.infer<typeof createProjectSchema>;
export type UpdateProjectDto = z.infer<typeof updateProjectSchema>;
export type AddProjectMemberDto = z.infer<typeof addProjectMemberSchema>;
export type UpdateProjectMemberRoleDto = z.infer<typeof updateProjectMemberRoleSchema>;
export type ProjectQueryDto = z.infer<typeof projectQuerySchema>;
