/**
 * IANA time zone validation.
 *
 * Kept apart from the clock itself so DTOs can validate a zone without pulling
 * in the rest of the module.
 */
import { IANAZone } from 'luxon';
import { AppError } from '../errors/AppError';

/**
 * Whether a string names a zone we are willing to store.
 *
 * Stricter than `IANAZone.isValidZone` on purpose. ICU also resolves the legacy
 * abbreviations — `EAT`, `EST`, `CET`, `EST5EDT` — and those are a trap: `EST`
 * is a *fixed* -05:00 with no daylight saving, so a New York workspace that
 * picked it would be an hour out from April to November, every year, silently.
 * Storing a zone rather than an offset is pointless if the zone is an offset.
 *
 * So: a region-qualified name (`Africa/Kampala`, `Etc/GMT-3` — the namespace
 * that exists precisely to say "I mean a fixed offset") or the literal `UTC`.
 */
export function isValidTimeZone(zone: string): boolean {
    if (typeof zone !== 'string' || zone.length === 0) return false;
    if (zone !== 'UTC' && !zone.includes('/')) return false;
    return IANAZone.isValidZone(zone);
}

export function assertValidTimeZone(zone: string): void {
    if (!isValidTimeZone(zone)) {
        throw new AppError(
            `"${zone}" is not a recognised time zone. Use an IANA name such as "Africa/Kampala".`,
            400,
            'INVALID_TIMEZONE',
        );
    }
}

/**
 * The zone a workspace gets when nobody has chosen one.
 *
 * Kampala rather than UTC: it is where the user base is, it matches the
 * `defaultCurrency @default("UGX")` precedent, and it has no DST — so the
 * default configuration is also the one with the fewest ways to be wrong.
 */
export const DEFAULT_TIME_ZONE = 'Africa/Kampala';
