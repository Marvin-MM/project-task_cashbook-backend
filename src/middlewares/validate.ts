import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../core/errors/AppError';

type ValidateTarget = 'body' | 'query' | 'params';

/**
 * Write a validated/coerced value back onto the request so downstream code
 * reads the parsed result rather than the raw input.
 *
 * `req.query` is not a plain property in Express 5 — it is a getter, defined
 * once on the shared request prototype, that RE-PARSES `req.url` on every
 * single access (see `defineGetter(req, 'query', ...)` in
 * `express/lib/request.js`; there is no per-request caching). Mutating the
 * object a previous `req.query` access happened to return — which is what
 * `Object.assign(req.query, result)` does — mutates a throwaway object: the
 * very next `req.query` read, in the next middleware or the controller,
 * invokes the getter again and gets a brand new object parsed straight from
 * the querystring, with every default and every coercion this middleware just
 * computed silently gone.
 *
 * The fix is to shadow the shared getter with an own property on THIS
 * request instance via `Object.defineProperty`, which Express's own getter
 * permits (`configurable: true`). `req.params`, by contrast, is a genuine
 * plain object the router assigns per-request — no getter involved — so
 * mutating it in place is safe and is left as-is below.
 */
function setRequestTarget(req: Request, target: ValidateTarget, value: unknown): void {
    if (target === 'query') {
        Object.defineProperty(req, 'query', {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    } else if (target === 'params') {
        const reqParams = (req as any).params;
        for (const key in reqParams) {
            delete reqParams[key];
        }
        Object.assign(reqParams, value);
    } else {
        (req as any)[target] = value;
    }
}

export function validate(schema: z.ZodType<any>, target: ValidateTarget = 'body') {
    return (req: Request, _res: Response, next: NextFunction): void => {
        try {
            const result = schema.parse(req[target]);
            setRequestTarget(req, target, result);
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
                        setRequestTarget(req, target as ValidateTarget, result);
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
