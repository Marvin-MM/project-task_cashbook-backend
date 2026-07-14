import { AppError } from '../errors/AppError';

/** Normalize ISO-like currency codes (UGX, USD, KES). */
export function normalizeCurrency(code: string | null | undefined, fallback = 'UGX'): string {
    const c = (code || fallback).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) {
        throw new AppError(
            `Invalid currency code "${code}". Use a 3-letter ISO code (e.g. UGX, USD).`,
            400,
            'INVALID_CURRENCY',
        );
    }
    return c;
}

/**
 * Hard block: no FX conversion. Money amounts may only combine when codes match.
 */
export function assertSameCurrency(
    expected: string,
    actual: string | null | undefined,
    context: string,
): void {
    const exp = normalizeCurrency(expected);
    const act = normalizeCurrency(actual, exp);
    if (exp !== act) {
        throw new AppError(
            `Currency mismatch (${context}): expected ${exp}, got ${act}. Cross-currency amounts are not converted.`,
            400,
            'CURRENCY_MISMATCH',
        );
    }
}

export function currenciesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    try {
        return normalizeCurrency(a) === normalizeCurrency(b);
    } catch {
        return false;
    }
}
