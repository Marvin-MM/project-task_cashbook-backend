import { z } from 'zod';

export const createPaymentModeSchema = z.object({
    name: z.string().min(1, 'Payment mode name is required').max(100),
});

export const updatePaymentModeSchema = z.object({
    name: z.string().min(1).max(100).optional(),
});

export type CreatePaymentModeDto = z.infer<typeof createPaymentModeSchema>;
export type UpdatePaymentModeDto = z.infer<typeof updatePaymentModeSchema>;
