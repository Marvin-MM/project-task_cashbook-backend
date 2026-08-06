import { z } from 'zod';

/**
 * Unlocking a module for one organisation.
 *
 * `feature` is an enum rather than a free string so a typo cannot silently
 * create a flag nothing reads — the guard looks up an exact FeatureKey, and a
 * misspelled row would leave the org locked out with no error anywhere.
 */
export const setWorkspaceFeatureSchema = z.object({
    feature: z.enum(['TICKETING']),
    enabled: z.boolean(),
});

export type SetWorkspaceFeatureDto = z.infer<typeof setWorkspaceFeatureSchema>;
