/**
 * Contract test for `validate(schema, 'query')`.
 *
 * This is the regression test for a real production bug: `req.query` in
 * Express 5 is a getter that re-parses `req.url` on EVERY access rather than
 * caching a plain object (see `express/lib/request.js`,
 * `defineGetter(req, 'query', ...)`). The old implementation mutated the
 * object one particular `req.query` read happened to return; the very next
 * read — in the controller — invoked the getter again and got a fresh,
 * unparsed object, silently discarding every Zod default and coercion.
 *
 * Symptom in production: a paginated GET route called with no querystring
 * threw `Argument skip is missing` (page/limit undefined, defaults never
 * applied), and one called with `?limit=60` threw `Argument take: Invalid
 * value provided. Expected Int, provided String` (coercion never applied).
 *
 * Mounted on a minimal Express app, mirroring idempotency.test.ts, so the
 * middleware is exercised exactly as the real app wires it — through the
 * actual `req.query` getter, not a mock.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate, validateMultiple } from './validate';

const paginationSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    search: z.string().optional(),
});

function buildApp(schema: z.ZodType<any>) {
    const app = express();
    app.get('/things', validate(schema, 'query'), (req, res) => {
        res.json({ query: req.query });
    });
    return app;
}

describe('validate(schema, "query") against the real Express 5 query getter', () => {
    it('applies defaults when the querystring is empty', async () => {
        const response = await request(buildApp(paginationSchema)).get('/things');

        expect(response.status).toBe(200);
        // Every value must be the SCHEMA'S default, not undefined — and page/limit
        // must be the coerced NUMBER type, not left as whatever Express parsed
        // (which, for an absent key, isn't even a string — it's missing entirely).
        expect(response.body.query).toEqual({ page: 1, limit: 20 });
    });

    it('coerces provided values to the types the schema declares', async () => {
        const response = await request(buildApp(paginationSchema))
            .get('/things?page=3&limit=60&search=gate');

        expect(response.status).toBe(200);
        expect(response.body.query).toEqual({ page: 3, limit: 60, search: 'gate' });
    });

    it('still rejects input the schema refuses', async () => {
        const response = await request(buildApp(paginationSchema)).get('/things?limit=999');
        expect(response.status).toBe(400);
    });
});

describe('validateMultiple targeting query', () => {
    it('applies defaults the same way as validate()', async () => {
        const app = express();
        app.get(
            '/things/:id',
            validateMultiple({ query: paginationSchema }),
            (req, res) => res.json({ query: req.query }),
        );

        const response = await request(app).get('/things/abc');
        expect(response.body.query).toEqual({ page: 1, limit: 20 });
    });
});

/**
 * A separate, unrelated gotcha this bug's discovery surfaced: `z.coerce.boolean()`
 * is `Boolean(value)`, which is `true` for ANY non-empty string — including the
 * string `"false"`. It has nothing to do with the getter-caching bug above (this
 * schema parses a plain object directly, no Express involved), but it lives in
 * several query DTOs across the app and is worth pinning down here so nobody
 * "fixes" the getter bug and assumes boolean filters are now trustworthy too.
 */
describe('the separate z.coerce.boolean() gotcha (not fixed by the getter change above)', () => {
    it('coerces the STRING "false" to true, because Boolean("false") is true', () => {
        const schema = z.object({ flag: z.coerce.boolean().default(true) });
        expect(schema.parse({ flag: 'false' }).flag).toBe(true);
    });

    it('is why ticketing.dto.ts uses booleanQueryParam() instead', async () => {
        const { listSalesSchema } = await import('../modules/ticketing/ticketing.dto');
        expect(listSalesSchema.parse({ includeVoided: 'false' }).includeVoided).toBe(false);
        expect(listSalesSchema.parse({}).includeVoided).toBe(true);
    });
});
