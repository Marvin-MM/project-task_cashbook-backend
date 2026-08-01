import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import path from 'node:path';

export default defineConfig({
    // esbuild (vitest's default transform) cannot emit decorator metadata, which
    // tsyringe's constructor injection depends on. SWC handles it.
    plugins: [
        swc.vite({
            module: { type: 'es6' },
            jsc: {
                target: 'es2022',
                parser: { syntax: 'typescript', decorators: true },
                transform: { decoratorMetadata: true, legacyDecorator: true },
            },
        }),
    ],
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Integration tests share one Postgres database and coordinate through
        // TRUNCATE between tests, so they must not run concurrently.
        // See src/test/setup.ts.
        pool: 'threads',
        poolOptions: { threads: { singleThread: true } },
        setupFiles: ['src/test/setup.ts'],
        testTimeout: 30_000,
        hookTimeout: 60_000,
        coverage: {
            provider: 'v8',
            include: ['src/core/**', 'src/modules/**'],
            exclude: ['**/*.dto.ts', '**/*.routes.ts', '**/*.test.ts', 'src/test/**'],
        },
    },
    resolve: {
        alias: { '@': path.resolve(__dirname, 'src') },
    },
});
