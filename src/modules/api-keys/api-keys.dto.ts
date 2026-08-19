import { z } from 'zod';
import { isIP } from 'node:net';

const allowedIpsSchema = z.array(z.string().max(64).refine(
    (ip) => isIP(ip) !== 0,
    'Each allowed IP must be a valid IPv4 or IPv6 address',
));

export const createApiKeySchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    scopes: z
        .array(z.enum(['WRITE_ENTRIES', 'READ_ENTRIES']))
        .min(1, 'At least one scope is required')
        .refine((scopes) => new Set(scopes).size === scopes.length, 'Scopes must be unique'),
    // Integration keys are least-privilege by default. Selecting a book also
    // opts that book into integration and creates its bookRef if needed.
    allowedBookIds: z.array(z.string().uuid()).min(1, 'Select at least one cashbook')
        .refine((ids) => new Set(ids).size === ids.length, 'Cashbooks must be unique'),
    allowedIps: allowedIpsSchema.optional().default([])
        .refine((ips) => new Set(ips).size === ips.length, 'IP addresses must be unique'),
    expiresAt: z.string().datetime().optional(),
}).superRefine(({ expiresAt }, ctx) => {
    if (expiresAt && new Date(expiresAt) <= new Date()) {
        ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must be in the future' });
    }
});

export const updateApiKeySchema = z.object({
    name: z.string().min(1).max(100).optional(),
    allowedBookIds: z.array(z.string().uuid()).min(1, 'Select at least one cashbook').optional()
        .refine((ids) => !ids || new Set(ids).size === ids.length, 'Cashbooks must be unique'),
    allowedIps: allowedIpsSchema.optional(),
    expiresAt: z.string().datetime().nullable().optional(),
});

export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;
export type UpdateApiKeyDto = z.infer<typeof updateApiKeySchema>;
