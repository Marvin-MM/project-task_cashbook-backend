import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../core/errors/AppError';

type ValidateTarget = 'body' | 'query' | 'params';

export function validate(schema: z.ZodType<any>, target: ValidateTarget = 'body') {
    return (req: Request, _res: Response, next: NextFunction): void => {
        try {
            const result = schema.parse(req[target]);

            // Express 5+ makes req.query and req.params getter-only, so we can't reassign the whole object.
            // Instead, we clear existing properties and assign the new validated values.
            if (target === 'query' || target === 'params') {
                const reqTarget = (req as any)[target];
                // Clear existing keys
                for (const key in reqTarget) {
                    delete reqTarget[key];
                }
                // Assign new keys from result
                Object.assign(reqTarget, result);
            } else {
                (req as any)[target] = result;
            }

            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                const formattedErrors: Record<string, string[]> = {};
                for (const issue of error.issues) {
                    const path = issue.path.join('.') || 'general';
                    if (!formattedErrors[path]) {
                        formattedErrors[path] = [];
                    }
                    formattedErrors[path].push(issue.message);
                }
                next(new ValidationError('Validation failed', formattedErrors));
                return;
            }
            next(error);
        }
    };
}

export function validateMultiple(schemas: { body?: z.ZodType<any>; query?: z.ZodType<any>; params?: z.ZodType<any> }) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        try {
            const allErrors: Record<string, string[]> = {};

            for (const [target, schema] of Object.entries(schemas)) {
                if (schema) {
                    try {
                        const result = schema.parse((req as any)[target]);

                        if (target === 'query' || target === 'params') {
                            const reqTarget = (req as any)[target];
                            for (const key in reqTarget) delete reqTarget[key];
                            Object.assign(reqTarget, result);
                        } else {
                            (req as any)[target] = result;
                        }
                    } catch (error) {
                        if (error instanceof z.ZodError) {
                            for (const issue of error.issues) {
                                const path = `${target}.${issue.path.join('.')}` || target;
                                if (!allErrors[path]) {
                                    allErrors[path] = [];
                                }
                                allErrors[path].push(issue.message);
                            }
                        }
                    }
                }
            }

            if (Object.keys(allErrors).length > 0) {
                next(new ValidationError('Validation failed', allErrors));
                return;
            }

            next();
        } catch (error) {
            next(error);
        }
    };
}
