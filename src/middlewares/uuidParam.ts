import { z } from 'zod';

/**
 * Build a Zod schema that validates one or more URL params as UUIDs.
 * Use with `validate(uuidParams('entryId'), 'params')`.
 *
 * @example
 *   validate(uuidParams('taskId'), 'params')
 *   validate(uuidParams('projectId', 'memberId'), 'params')
 */
export function uuidParams(...names: string[]) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const name of names) {
        // passthrough = don't strip other params (mergeParams carries workspaceId etc.)
        shape[name] = z.string().uuid(`Invalid ${name}: must be a valid UUID`);
    }
    // Use passthrough so other params from parent routers are preserved
    return z.object(shape).passthrough();
}
