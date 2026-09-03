/**
 * The Graph API version, in exactly one place.
 *
 * Marketing API versions live roughly TWELVE months, not the ~24 the Graph API
 * deprecation table implies — they are two different clocks and conflating them is
 * how a system dies on a Tuesday. v26.0 shipped 2026-07-29.
 *
 * Meta silently auto-upgrades calls across versions and signals it only through the
 * `X-Ad-Api-Version-Warning` response header, which the client surfaces loudly rather
 * than swallowing. Disable auto-upgrade in
 * App Dashboard > Marketing API > Settings > Ads API Version Settings so a version
 * mismatch fails audibly instead of changing behaviour underneath a running campaign.
 *
 * Never make an unversioned call: those resolve to whatever version is set in a UI
 * field on the App Dashboard, so the behaviour of your deploy depends on a setting
 * that is not in your repository.
 */
export const GRAPH_API_VERSION = 'v26.0' as const;

export const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}` as const;

/** Re-verify against the changelog before this date; budget a migration every ~6 months. */
export const VERSION_REVIEW_BY = '2027-04-01' as const;
