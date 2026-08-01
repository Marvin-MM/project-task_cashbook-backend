/**
 * Geofence arithmetic for attendance.
 *
 * Lifted verbatim from time-tracking.service.ts so the clock-in path and the
 * (coming) per-task sites share one implementation — two ways to decide whether
 * a point is inside a circle is how a WARN/ENFORCE policy ends up applied
 * inconsistently between them.
 */

export interface LatLng {
    latitude: number;
    longitude: number;
}

export interface GeofenceSite extends LatLng {
    id: string;
    name: string;
    radiusMeters: number;
}

/** How a workspace treats someone clocking in outside every known site. */
export type GeofenceEnforcement = 'OFF' | 'WARN' | 'ENFORCE';

/** Great-circle distance in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
    const earthRadiusMeters = 6_371_000;
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const lat1 = toRadians(a.latitude);
    const lat2 = toRadians(b.latitude);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusMeters * Math.asin(Math.sqrt(h));
}

export interface GeofenceVerdict {
    /** Whether the caller may proceed. Under WARN this is true even off-site. */
    ok: boolean;
    /** Whether the point actually fell inside a site, regardless of policy. */
    withinFence: boolean;
    siteId: string | null;
    siteName: string | null;
    distanceMeters: number | null;
    reason?: 'NO_SITES' | 'LOCATION_REQUIRED' | 'OUTSIDE_ALL_SITES';
}

/**
 * Evaluate a position against every site the caller may use.
 *
 * Returns the *nearest* site rather than the first match, so the recorded
 * `siteId` is the one the person was actually standing at when two fences
 * overlap.
 */
export function evaluateGeofence(
    sites: GeofenceSite[],
    actual: LatLng | null | undefined,
    enforcement: GeofenceEnforcement,
): GeofenceVerdict {
    const miss = (reason: GeofenceVerdict['reason']): GeofenceVerdict => ({
        ok: enforcement !== 'ENFORCE',
        withinFence: false,
        siteId: null,
        siteName: null,
        distanceMeters: null,
        reason,
    });

    if (enforcement === 'OFF' || sites.length === 0) {
        // Nothing configured is not a violation — it is a workspace that has not
        // asked for geofencing. Always allowed, and not recorded as off-site.
        return {
            ok: true,
            withinFence: true,
            siteId: null,
            siteName: null,
            distanceMeters: null,
            reason: sites.length === 0 ? 'NO_SITES' : undefined,
        };
    }

    if (!actual || actual.latitude == null || actual.longitude == null) {
        return miss('LOCATION_REQUIRED');
    }

    let nearest: { site: GeofenceSite; distance: number } | null = null;
    for (const site of sites) {
        const distance = distanceMeters(site, actual);
        if (!nearest || distance < nearest.distance) nearest = { site, distance };
    }

    // sites.length > 0 was checked above, so nearest is non-null here.
    const { site, distance } = nearest!;
    const withinFence = distance <= site.radiusMeters;

    return {
        ok: withinFence || enforcement !== 'ENFORCE',
        withinFence,
        siteId: withinFence ? site.id : null,
        siteName: withinFence ? site.name : null,
        distanceMeters: Math.round(distance),
        reason: withinFence ? undefined : 'OUTSIDE_ALL_SITES',
    };
}
