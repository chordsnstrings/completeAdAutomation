import { validateBrand } from "../domain/brand.ts";
import { ARCHETYPES } from "../meta/objectives.ts";
import { FUNNEL_TEMPLATES } from "../funnel/templates.ts";
import { currencyOffset } from "../meta/publish.ts";
import type { ManagedBrand, Settings } from "./types.ts";
import { AppError, nowIso } from "./types.ts";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function string(
  value: unknown,
  name: string,
  max = 2000,
  required = false,
): string {
  if (value === undefined || value === null) {
    if (required) throw new AppError(`${name} is required.`);
    return "";
  }
  if (typeof value !== "string" || value.length > max)
    throw new AppError(`${name} must be text up to ${max} characters.`);
  const result = value.trim();
  if (required && !result) throw new AppError(`${name} is required.`);
  return result;
}
export function number(
  value: unknown,
  name: string,
  min = 0,
  max = 1e9,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new AppError(
      `${name} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}.`,
    );
  return value;
}
export function lines(value: unknown, name: string, max = 50): string[] {
  const items = typeof value === "string" ? value.split("\n") : value;
  if (!Array.isArray(items) || items.length > max)
    throw new AppError(`${name} must contain up to ${max} entries.`);
  return items.map((v) => string(v, name, 500)).filter(Boolean);
}
export function httpsUrl(
  value: unknown,
  name: string,
  required = false,
): string {
  const s = string(value, name, 2048, required);
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new AppError(`${name} must be a full HTTPS URL.`);
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw new AppError(
      `${name} must be a public HTTPS URL without credentials.`,
    );
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    !host.includes(".")
  )
    throw new AppError(`${name} must use a public hostname.`);
  return u.href;
}
export function validateManagedBrand(
  input: unknown,
  existing?: ManagedBrand,
): ManagedBrand {
  const o = object(input);
  const spend = object(o["spend"]);
  const claims = object(o["claims"]);
  const dest = object(o["destination"] ?? {});
  const id = existing?.id ?? string(o["id"], "Brand ID", 60, true);
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id))
    throw new AppError(
      "Brand ID must use lowercase letters, numbers and hyphens.",
    );
  const mode = string(o["mode"] ?? existing?.mode ?? "SIMULATE", "Mode");
  if (!["SIMULATE", "STAGE", "LIVE"].includes(mode))
    throw new AppError("Choose a valid operating mode.");
  const archetype = string(o["archetype"], "Goal", 80, true);
  if (!Object.hasOwn(ARCHETYPES, archetype))
    throw new AppError("Unknown campaign goal.");
  const funnel = string(o["funnel"] ?? "auto", "Funnel");
  if (funnel !== "auto" && !Object.hasOwn(FUNNEL_TEMPLATES, funnel))
    throw new AppError("Unknown funnel.");
  const currency = string(
    o["currency"] ?? "AED",
    "Currency",
    3,
    true,
  ).toUpperCase();
  currencyOffset(currency);
  const timezone = string(o["timezone"] ?? "Asia/Dubai", "Timezone", 80, true);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new AppError("Choose a valid timezone.");
  }
  const countries = lines(o["countries"] ?? ["AE"], "Countries", 30).map((v) =>
    v.toUpperCase(),
  );
  if (!countries.length || countries.some((v) => !/^[A-Z]{2}$/.test(v)))
    throw new AppError("Use two-letter country codes such as AE.");
  const categories = lines(
    o["specialAdCategories"] ?? ["NONE"],
    "Ad categories",
    7,
  );
  const allowed = [
    "NONE",
    "EMPLOYMENT",
    "HOUSING",
    "CREDIT",
    "ISSUES_ELECTIONS_POLITICS",
    "ONLINE_GAMBLING_AND_GAMING",
    "FINANCIAL_PRODUCTS_SERVICES",
  ];
  if (
    categories.some((v) => !allowed.includes(v)) ||
    (categories.includes("NONE") && categories.length > 1)
  )
    throw new AppError("Choose valid special ad categories.");
  const assets = string(o["assets"] ?? "nothing", "Existing audience");
  if (
    !["nothing", "video_views", "website_traffic", "customers"].includes(assets)
  )
    throw new AppError("Unknown audience history.");
  const destination: ManagedBrand["destination"] = {};
  for (const key of ["url", "objectStoreUrl"] as const) {
    const v = httpsUrl(dest[key], key);
    if (v) destination[key] = v;
  }
  for (const key of [
    "leadFormId",
    "pixelId",
    "customEventType",
    "productSetId",
    "applicationId",
    "phoneNumber",
  ] as const) {
    const v = string(dest[key], key, 120);
    if (v) destination[key] = v;
  }
  const brand: ManagedBrand = {
    id,
    name: string(o["name"], "Brand name", 120, true),
    pageId: string(o["pageId"], "Facebook Page", 80),
    adAccountId: string(o["adAccountId"], "Ad account", 80),
    archetype: archetype as ManagedBrand["archetype"],
    destination,
    spend: {
      dailyBudgetMinor: number(
        spend["dailyBudgetMinor"],
        "Daily budget",
        1,
        1e9,
        true,
      ),
      maxDailyBudgetMinor: number(
        spend["maxDailyBudgetMinor"],
        "Maximum daily budget",
        1,
        1e9,
        true,
      ),
      targetCpaMinor: number(
        spend["targetCpaMinor"],
        "Target cost per result",
        1,
        1e9,
        true,
      ),
    },
    claims: {
      substantiated: lines(claims["substantiated"], "Approved claims"),
      neverSay: lines(claims["neverSay"] ?? [], "Prohibited phrases"),
      neverShow: lines(claims["neverShow"] ?? [], "Prohibited imagery"),
      likenessRightsConfirmed: claims["likenessRightsConfirmed"] === true,
    },
    specialAdCategories: categories as ManagedBrand["specialAdCategories"],
    countries,
    proposition: string(o["proposition"], "What you sell", 4000, true),
    currency,
    currencyUnitVersion: 1,
    timezone,
    funnel: funnel as ManagedBrand["funnel"],
    assets: assets as ManagedBrand["assets"],
    mode: mode as ManagedBrand["mode"],
    autonomy: o["autonomy"] === true,
    warmPoolSize: number(
      o["warmPoolSize"] ?? 0,
      "Warm audience size",
      0,
      1e9,
      true,
    ),
    purchasesLast180d: number(
      o["purchasesLast180d"] ?? 0,
      "Recent conversions",
      0,
      1e9,
      true,
    ),
    audienceIds: Object.fromEntries(
      Object.entries(object(o["audienceIds"] ?? {})).map(([k, v]) => [
        string(k, "Audience type", 90),
        string(v, "Audience ID", 90),
      ]),
    ),
    language: string(o["language"] ?? "English", "Language", 80, true),
    generationDailyUsd: number(
      o["generationDailyUsd"] ?? 10,
      "Daily production allowance",
      0.1,
      10000,
    ),
    creativesPerCycle: number(
      o["creativesPerCycle"] ?? 3,
      "Creatives per cycle",
      1,
      6,
      true,
    ),
    refreshDays: number(
      o["refreshDays"] ?? 7,
      "Creative refresh interval",
      3,
      90,
      true,
    ),
    privacyPolicyUrl: httpsUrl(o["privacyPolicyUrl"], "Privacy policy"),
    websiteDescription: string(
      o["websiteDescription"],
      "Destination description",
      4000,
    ),
    productImage: httpsUrl(o["productImage"], "Product reference image"),
    resultActionType: string(
      o["resultActionType"],
      "Result reporting key",
      160,
    ),
    catalogCreativeId: string(
      o["catalogCreativeId"],
      "Catalogue creative ID",
      80,
    ),
    leadWebhookUrl: httpsUrl(o["leadWebhookUrl"], "CRM webhook"),
    leadFormLocale: string(
      o["leadFormLocale"] ?? "en_US",
      "Form language",
      10,
      true,
    ),
    lifetimeLimitMinor: number(
      o["lifetimeLimitMinor"] ?? 0,
      "Lifetime limit",
      0,
      1e12,
      true,
    ),
    attributionClickDays: number(
      o["attributionClickDays"] ?? 7,
      "Attribution window",
      1,
      7,
      true,
    ),
    lastCheckedAt: "",
    preflight: [],
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  if (![1, 7].includes(brand.attributionClickDays))
    throw new AppError("Attribution must be 1 or 7 days.");
  const instagram = string(o["instagramUserId"], "Instagram account", 80);
  if (instagram) brand.instagramUserId = instagram;
  if (spend["targetRoas"] !== undefined)
    brand.spend.targetRoas = number(
      spend["targetRoas"],
      "Target return on spend",
      0.1,
      1000,
    );
  if (spend["contributionMarginMinor"] !== undefined)
    brand.spend.contributionMarginMinor = number(
      spend["contributionMarginMinor"],
      "Contribution margin",
      1,
      1e9,
      true,
    );
  if (mode === "SIMULATE") {
    brand.pageId ||= "000000000000000";
    brand.adAccountId ||= "act_000000000000000";
    if (archetype === "instant_form_lead")
      brand.destination.leadFormId ||= "000000000000000";
  }
  if (!/^act_\d+$/.test(brand.adAccountId) || !/^\d+$/.test(brand.pageId))
    throw new AppError(
      "Choose a Facebook Page and ad account, or use simulation.",
    );
  for (const key of [
    "pixelId",
    "leadFormId",
    "applicationId",
    "productSetId",
  ] as const)
    if (destination[key] && !/^\d+$/.test(destination[key]!))
      throw new AppError(`${key} must contain digits only.`);
  if (brand.catalogCreativeId && !/^\d+$/.test(brand.catalogCreativeId))
    throw new AppError("Catalogue creative ID must contain digits only.");
  if (
    brand.resultActionType &&
    !/^[a-zA-Z0-9_.:-]+$/.test(brand.resultActionType)
  )
    throw new AppError(
      "The result reporting key must be a Meta action_type identifier.",
    );
  if (
    archetype === "catalog_sales" &&
    !brand.catalogCreativeId &&
    mode !== "SIMULATE"
  )
    throw new AppError(
      "Select an existing feed-based catalogue creative from this ad account.",
    );
  if (
    Object.values(brand.audienceIds).some(
      (id) => !/^\d+$/.test(id) && mode !== "SIMULATE",
    )
  )
    throw new AppError("Audience IDs must contain digits only.");
  // A form can be provisioned on the connected Page during preflight.
  const validationBrand = structuredClone(brand);
  if (
    archetype === "instant_form_lead" &&
    !destination.leadFormId &&
    brand.privacyPolicyUrl
  )
    validationBrand.destination.leadFormId = "pending";
  const errors = validateBrand(validationBrand);
  if (errors.length) throw new AppError(errors.join("\n"));
  if (existing?.account && existing.adAccountId === brand.adAccountId)
    brand.account = existing.account;
  return brand;
}
export function validateSettings(input: unknown, previous: Settings): Settings {
  const o = object(input);
  const next = { ...previous };
  if (o["provider"] !== undefined) {
    if (!["veo", "seedance"].includes(String(o["provider"])))
      throw new AppError("Choose a video provider.");
    next.provider = o["provider"] as Settings["provider"];
  }
  for (const k of [
    "textModel",
    "videoModel",
    "googleProject",
    "googleBucket",
    "googleRegion",
  ] as const)
    if (o[k] !== undefined) next[k] = string(o[k], k, 200);
  for (const k of [
    "textInputUsdPerMillion",
    "textOutputUsdPerMillion",
  ] as const)
    if (o[k] !== undefined) next[k] = number(o[k], k, 0.01, 1000);
  if (o["pollMinutes"] !== undefined)
    next.pollMinutes = number(
      o["pollMinutes"],
      "Sync interval",
      15,
      1440,
      true,
    );
  return next;
}
