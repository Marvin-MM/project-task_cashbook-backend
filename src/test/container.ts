/**
 * Builds real service instances wired to the test database.
 *
 * Uses a child tsyringe container so registering the test PrismaClient does not
 * disturb the app container, and so services keep their real dependency graph
 * (no hand-wiring that could drift from production).
 */
import 'reflect-metadata';
import { container } from 'tsyringe';
import { testPrisma } from './setup';

const testContainer = container.createChildContainer();
testContainer.registerInstance('PrismaClient', testPrisma);

export function resolveService<T>(token: new (...args: any[]) => T): T {
    return testContainer.resolve(token);
}

export { testContainer };
