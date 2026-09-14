import { createHmac, createHash } from "node:crypto";
import { publicBytes } from "./network.ts";
import { AppError } from "./types.ts";
import type { Lead } from "./types.ts";
import { object, string, number, httpsUrl } from "./validation.ts";

/** At-least-once delivery: consumers deduplicate the stable X-Event-ID. */
export async function deliverWebhook(
  url: string,
  lead: Lead,
  secret: string,
  transport: typeof publicBytes = publicBytes,
): Promise<void> {
  if (!secret)
    throw new AppError("Set a CRM webhook signing secret in Connections.");
  const body = JSON.stringify({
    type: "lead.created",
    id: lead.id,
    brandId: lead.brandId,
    createdAt: lead.createdAt,
    fields: lead.fields,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  await transport(
    url,
    1024 * 1024,
    {
      "content-type": "application/json",
      "x-event-id": lead.id,
      "x-timestamp": timestamp,
      "x-signature-sha256": signature,
    },
    0,
    body,
  );
}
export function conversionPayload(
  input: unknown,
  now = Date.now(),
): Record<string, unknown> {
  const o = object(input);
  if (o["consent"] !== true)
    throw new AppError(
      "Conversion events require consent=true from the collecting application.",
    );
  const event = string(o["event_name"], "Event name", 80, true);
  if (
    ![
      "Purchase",
      "Lead",
      "CompleteRegistration",
      "Contact",
      "Schedule",
      "AddToCart",
      "ViewContent",
      "Subscribe",
    ].includes(event)
  )
    throw new AppError("Unsupported conversion event.");
  const time = number(
    o["event_time"],
    "Event time",
    Math.floor(now / 1000) - 7 * 86400,
    Math.floor(now / 1000),
    true,
  );
  const id = string(o["event_id"], "Stable event ID", 120, true),
    data = object(o["user_data"]);
  const user: Record<string, unknown> = {};
  for (const key of ["em", "ph", "external_id"] as const) {
    const value = string(data[key], key, 300);
    if (value) {
      const normalized =
        key === "ph" ? value.replace(/\D/g, "") : value.trim().toLowerCase();
      user[key] = [createHash("sha256").update(normalized).digest("hex")];
    }
  }
  for (const key of [
    "fbp",
    "fbc",
    "client_ip_address",
    "client_user_agent",
  ] as const) {
    const value = string(data[key], key, 1000);
    if (value) user[key] = value;
  }
  if (!user["em"] && !user["ph"] && !user["external_id"] && !user["fbc"])
    throw new AppError("At least one matching identifier is required.");
  const custom: Record<string, unknown> = {};
  if (o["value"] !== undefined) {
    custom["value"] = number(o["value"], "Value", 0, 1e10);
    const currency = string(o["currency"], "Currency", 3, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      throw new AppError("Currency must be a three-letter code.");
    custom["currency"] = currency;
  }
  if (event === "Purchase" && custom["value"] === undefined)
    throw new AppError("Purchase events require value and currency.");
  return {
    event_name: event,
    event_id: id,
    event_time: time,
    action_source: "website",
    event_source_url: httpsUrl(o["event_source_url"], "Event source URL", true),
    user_data: user,
    ...(Object.keys(custom).length ? { custom_data: custom } : {}),
  };
}
