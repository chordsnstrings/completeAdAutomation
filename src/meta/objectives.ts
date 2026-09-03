/**
 * The ODAX legality matrix, as data.
 *
 * Objective x destination_type x optimization_goal x promoted_object is combinatorial,
 * and Meta rejects an illegal tuple with a generic `code 100 "Invalid parameter"` whose
 * error_user_msg says nothing useful. Validating client-side is the difference between
 * a clear log line and a three-hour debug session — and for a system that publishes
 * unattended, an opaque rejection at 3am is worse than that.
 *
 * Sources:
 *  - destination_type per objective — /docs/marketing-api/adset/destination_type/
 *  - ODAX objective mapping        — /docs/marketing-api/reference/ad-campaign-group
 *  - billing_event legality        — /docs/marketing-api/bidding/overview/billing-events/
 *
 * Every entry carries `confidence`. That is not decoration: `OUTCOME_SALES` never
 * appears as a target objective anywhere in Meta's published Objective Mapping table,
 * so the website-purchase tuple — the most commercially important combination here — is
 * INFERRED rather than documented. The system must know which of its own assumptions
 * are unverified, so a first live publish can settle them deliberately rather than
 * discovering the gap through a rejection.
 */

export type Objective =
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_SALES'
  | 'OUTCOME_APP_PROMOTION';

export type DestinationType =
  | 'WEBSITE' | 'APP' | 'MESSENGER' | 'WHATSAPP' | 'PHONE_CALL' | 'INSTAGRAM_DIRECT'
  | 'ON_AD' | 'ON_POST' | 'ON_EVENT' | 'ON_VIDEO' | 'ON_PAGE'
  | 'LEAD_FROM_MESSENGER' | 'LEAD_FROM_IG_DIRECT' | 'UNDEFINED';

export type OptimizationGoal =
  | 'OFFSITE_CONVERSIONS' | 'VALUE' | 'LEAD_GENERATION' | 'QUALITY_LEAD' | 'QUALITY_CALL'
  | 'LINK_CLICKS' | 'LANDING_PAGE_VIEWS' | 'IMPRESSIONS' | 'REACH' | 'THRUPLAY'
  | 'CONVERSATIONS' | 'APP_INSTALLS' | 'POST_ENGAGEMENT' | 'PAGE_LIKES' | 'AD_RECALL_LIFT';

export type BillingEvent =
  | 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY' | 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS';

export type PromotedObjectKind = 'pixel_event' | 'page' | 'app' | 'product_set' | 'none';

export type Confidence =
  /** Quoted from a Meta primary source. */
  | 'documented'
  /** Consistent with the docs but not stated. Settle it with a live create call. */
  | 'inferred';

/**
 * What the advertiser is actually buying. This is the per-brand knob — a business with
 * several product lines runs a different archetype per brand without the pipeline
 * changing shape, and an individual ad can override it again.
 */
export type ConversionArchetype =
  | 'website_purchase'
  | 'website_lead'
  | 'instant_form_lead'
  | 'messenger_lead'
  | 'whatsapp_conversation'
  | 'phone_call'
  | 'catalog_sales'
  | 'traffic'
  | 'app_install';

export interface ArchetypeSpec {
  archetype: ConversionArchetype;
  objective: Objective;
  /**
   * Omitted entirely when undefined. That is deliberate and load-bearing:
   * `OUTCOME_TRAFFIC` does NOT list `WEBSITE` as a legal destination_type, so a plain
   * website-traffic ad set must omit the field and let it resolve to the default rather
   * than sending the value that looks obviously correct.
   */
  destinationType?: DestinationType;
  optimizationGoal: OptimizationGoal;
  billingEvent: BillingEvent;
  promotedObject: PromotedObjectKind;
  confidence: Confidence;
  /** Why this tuple, and what to watch. Surfaced in logs when a publish fails. */
  note: string;
}

/** IMPRESSIONS is legal for every optimization goal; only these accept anything else. */
const BILLING_EVENT_LEGALITY: Partial<Record<OptimizationGoal, readonly BillingEvent[]>> = {
  LINK_CLICKS: ['IMPRESSIONS', 'LINK_CLICKS'],
  THRUPLAY: ['IMPRESSIONS', 'THRUPLAY'],
};

export function isBillingEventLegal(goal: OptimizationGoal, event: BillingEvent): boolean {
  const allowed = BILLING_EVENT_LEGALITY[goal];
  return allowed ? allowed.includes(event) : event === 'IMPRESSIONS';
}

/** destination_type values Meta documents as available per objective. */
const DESTINATION_LEGALITY: Record<Objective, readonly DestinationType[]> = {
  OUTCOME_AWARENESS: ['UNDEFINED', 'WEBSITE', 'MESSENGER', 'WHATSAPP', 'INSTAGRAM_DIRECT'],
  OUTCOME_TRAFFIC: ['UNDEFINED', 'MESSENGER', 'WHATSAPP', 'PHONE_CALL'],
  OUTCOME_ENGAGEMENT: [
    'UNDEFINED', 'MESSENGER', 'WHATSAPP', 'PHONE_CALL', 'INSTAGRAM_DIRECT',
    'ON_POST', 'ON_EVENT', 'ON_VIDEO', 'ON_PAGE',
  ],
  OUTCOME_LEADS: [
    'ON_AD', 'LEAD_FROM_MESSENGER', 'LEAD_FROM_IG_DIRECT', 'PHONE_CALL',
    'UNDEFINED', 'WEBSITE', 'APP',
  ],
  OUTCOME_SALES: ['WEBSITE', 'MESSENGER', 'PHONE_CALL'],
  OUTCOME_APP_PROMOTION: ['UNDEFINED'],
};

export const ARCHETYPES: Record<ConversionArchetype, ArchetypeSpec> = {
  website_purchase: {
    archetype: 'website_purchase',
    objective: 'OUTCOME_SALES',
    destinationType: 'WEBSITE',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'pixel_event',
    confidence: 'inferred',
    note:
      "OUTCOME_SALES never appears as a target objective in Meta's Objective Mapping table, " +
      'so this tuple is reasoned rather than quoted. It is the highest-value unverified ' +
      'assumption in the system — settle it with a real create call before relying on it.',
  },
  website_lead: {
    archetype: 'website_lead',
    objective: 'OUTCOME_LEADS',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'pixel_event',
    confidence: 'documented',
    note: 'destination_type omitted — the mapping row for pixel conversions under OUTCOME_LEADS does not set it.',
  },
  instant_form_lead: {
    archetype: 'instant_form_lead',
    objective: 'OUTCOME_LEADS',
    destinationType: 'ON_AD',
    optimizationGoal: 'LEAD_GENERATION',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'page',
    confidence: 'documented',
    note:
      'On-Meta destination: needs no domain verification, no pixel and no AEM configuration. ' +
      'Requires the leads_retrieval scope, which cannot be added to an existing token.',
  },
  messenger_lead: {
    archetype: 'messenger_lead',
    objective: 'OUTCOME_LEADS',
    destinationType: 'LEAD_FROM_MESSENGER',
    optimizationGoal: 'LEAD_GENERATION',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'page',
    confidence: 'documented',
    note: 'On-Meta destination — no website prerequisites.',
  },
  whatsapp_conversation: {
    archetype: 'whatsapp_conversation',
    objective: 'OUTCOME_ENGAGEMENT',
    destinationType: 'WHATSAPP',
    optimizationGoal: 'CONVERSATIONS',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'page',
    confidence: 'inferred',
    note:
      'The mapping table documents CONVERSATIONS for MESSENGER; WHATSAPP is a legal destination ' +
      'but the goal pairing is not stated. Verify before use.',
  },
  phone_call: {
    archetype: 'phone_call',
    objective: 'OUTCOME_LEADS',
    destinationType: 'PHONE_CALL',
    optimizationGoal: 'QUALITY_CALL',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'page',
    confidence: 'inferred',
    note:
      "Meta's per-value requirements for PHONE_CALL still name the LEGACY objectives " +
      '(PRODUCT_CATALOG_SALES / CONVERSIONS), contradicting the objective table. Needs an empirical test.',
  },
  catalog_sales: {
    archetype: 'catalog_sales',
    objective: 'OUTCOME_SALES',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'product_set',
    confidence: 'inferred',
    note:
      'The PRODUCT_CATALOG_SALES -> OUTCOME_SALES mapping row could not be confirmed against the ' +
      'live doc. Catalogue ads are a separate creative shape (template_data), not a variant of the video pipeline.',
  },
  traffic: {
    archetype: 'traffic',
    objective: 'OUTCOME_TRAFFIC',
    optimizationGoal: 'LANDING_PAGE_VIEWS',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'none',
    confidence: 'documented',
    note:
      'destination_type deliberately omitted — OUTCOME_TRAFFIC does not list WEBSITE as legal, ' +
      'so sending the obvious-looking value is itself the bug.',
  },
  app_install: {
    archetype: 'app_install',
    objective: 'OUTCOME_APP_PROMOTION',
    optimizationGoal: 'APP_INSTALLS',
    billingEvent: 'IMPRESSIONS',
    promotedObject: 'app',
    confidence: 'documented',
    note: 'Requires application_id and object_store_url.',
  },
};

export class IllegalTupleError extends Error {}

/**
 * Validates a spec against the legality tables, so an illegal combination fails here
 * with a specific message rather than at Meta with a generic one.
 */
export function validateSpec(spec: ArchetypeSpec): void {
  if (!isBillingEventLegal(spec.optimizationGoal, spec.billingEvent)) {
    throw new IllegalTupleError(
      `billing_event=${spec.billingEvent} is not legal for optimization_goal=${spec.optimizationGoal}. ` +
        `IMPRESSIONS is legal for every goal; only LINK_CLICKS and THRUPLAY accept anything else.`,
    );
  }
  if (spec.destinationType !== undefined) {
    const legal = DESTINATION_LEGALITY[spec.objective];
    if (!legal.includes(spec.destinationType)) {
      throw new IllegalTupleError(
        `destination_type=${spec.destinationType} is not available for ${spec.objective}. ` +
          `Legal values: ${legal.join(', ')}. Meta rejects this as a generic code 100.`,
      );
    }
  }
}

export function specFor(archetype: ConversionArchetype): ArchetypeSpec {
  const spec = ARCHETYPES[archetype];
  validateSpec(spec);
  return spec;
}

/** Archetypes resting on an assumption no live publish has settled yet. */
export function unverifiedArchetypes(): ArchetypeSpec[] {
  return Object.values(ARCHETYPES).filter((s) => s.confidence === 'inferred');
}
