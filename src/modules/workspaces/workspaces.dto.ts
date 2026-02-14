import { z } from 'zod';

export const createWorkspaceSchema = z.object({
    name: z.string().min(1, 'Workspace name is required').max(200),
    type: z.literal('BUSINESS'),
});

export const updateWorkspaceSchema = z.object({
    name: z.string().min(1).max(200).optional(),
});

export type CreateWorkspaceDto = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceDto = z.infer<typeof updateWorkspaceSchema>;
