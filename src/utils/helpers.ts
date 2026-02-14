import { Decimal } from '@prisma/client/runtime/library';
import { PaginationParams, PaginatedResponse } from '../core/types';

// ─── Pagination Helpers ────────────────────────────────
export function parsePagination(query: Record<string, any>): PaginationParams {
    const page = Math.max(1, parseInt(query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit as string) || 20));
    const sortBy = (query.sortBy as string) || 'createdAt';
    const sortOrder = (query.sortOrder === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
    return { page, limit, sortBy, sortOrder };
}

export function buildPaginatedResponse<T>(
    data: T[],
    total: number,
    params: PaginationParams
): PaginatedResponse<T> {
    const totalPages = Math.ceil(total / params.limit);
    return {
        data,
        pagination: {
            page: params.page,
            limit: params.limit,
            total,
            totalPages,
            hasNext: params.page < totalPages,
            hasPrevious: params.page > 1,
        },
    };
}

// ─── Decimal Helpers ───────────────────────────────────
export function toDecimal(value: string | number): Decimal {
    return new Decimal(value.toString());
}

export function decimalToNumber(value: Decimal): number {
    return value.toNumber();
}

export function formatCurrency(value: Decimal, decimals = 2): string {
    return value.toFixed(decimals);
}

// ─── Date Helpers ──────────────────────────────────────
export function isDateInPast(date: Date): boolean {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    return compareDate < today;
}

export function startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

export function endOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
}

// ─── Misc Helpers ──────────────────────────────────────
export function excludeFields<T, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
    const result = { ...obj };
    for (const key of keys) {
        delete result[key];
    }
    return result;
}

export function sanitizeObject(obj: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
