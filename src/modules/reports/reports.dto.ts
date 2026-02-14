import { z } from 'zod';

export const reportQuerySchema = z.object({
    startDate: z.string().datetime('Start date must be valid ISO datetime'),
    endDate: z.string().datetime('End date must be valid ISO datetime'),
    format: z.enum(['pdf', 'excel']).default('pdf'),
    type: z.enum(['INCOME', 'EXPENSE']).optional(),
    categoryId: z.string().uuid().optional(),
});

export type ReportQueryDto = z.infer<typeof reportQuerySchema>;
