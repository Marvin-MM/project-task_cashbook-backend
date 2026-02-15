import { z } from 'zod';

const MAX_DATE_RANGE_DAYS = 365;

export const reportQuerySchema = z.object({
    startDate: z.string().datetime('Start date must be valid ISO datetime'),
    endDate: z.string().datetime('End date must be valid ISO datetime'),
    format: z.enum(['pdf', 'excel']).default('pdf'),
    type: z.enum(['INCOME', 'EXPENSE']).optional(),
    categoryId: z.string().uuid().optional(),
}).refine(
    (data) => {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        return end >= start;
    },
    { message: 'End date must be on or after start date', path: ['endDate'] }
).refine(
    (data) => {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        const diffMs = end.getTime() - start.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        return diffDays <= MAX_DATE_RANGE_DAYS;
    },
    { message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`, path: ['endDate'] }
);

export type ReportQueryDto = z.infer<typeof reportQuerySchema>;
