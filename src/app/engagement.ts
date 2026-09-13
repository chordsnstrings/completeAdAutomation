import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";
import type { Vault } from "./security.ts";
import type { MetaGateway, GraphNode } from "./meta.ts";
import { metaConnection } from "./meta-auth.ts";
import { AppError, DEFAULT_SETTINGS, nowIso } from "./types.ts";
import type { ManagedBrand } from "./types.ts";
import { MetaApiError } from "../meta/errors.ts";
import { RateLimited } from "../meta/scheduler.ts";
import { parseNextPage } from "../meta/insights.ts";
import { PageIntelligence, ENGAGEMENT_MODELS, sourceUrl } from "./page-intelligence.ts";
import type { AiReply, ReplyProvider, PageKnowledge } from "./page-intelligence.ts";
import type { publicBytes } from "./network.ts";

export interface ReplyRule { id: string; label: string; questions: string[]; reply: string }
export interface EngagementConfig {
  id: string; brandId: string; mode: "off" | "review" | "auto";
  dailyLimit: number; rules: ReplyRule[]; autoSince: string; updatedAt: string;
  accountId: string; pageId: string; instagramId: string;
  lastDiscoveryAt: string; error: string; unmappedAds: number; subscriptions: string[];
  aiEnabled: boolean; provider: ReplyProvider; model: string; aiDailyLimit: number; knowledgeUrls: string[];
}
export interface CommentThread {
  id: string; brandId: string; platform: "facebook" | "instagram"; remoteId: string;
  pageId: string; actorId: string; adName: string; adIds: string[];
  lastSyncedAt: string; error: string;
  destinationUrls: string[]; adText: string; cta: "message" | "form" | "visit"; formId: string;
  messageChannel?: "messenger" | "whatsapp" | "instagram";
  permalinkUrl?: string;
  ambiguousDestination?: boolean;
}
export type CommentStatus = "review" | "queued" | "sending" | "replied" | "answered" | "uncertain" | "failed" | "ignored" | "deleted";
export interface AdComment {
  id: string; brandId: string; threadId: string; platform: CommentThread["platform"];
  remoteId: string; parentId: string; authorId: string; author: string; text: string;
  createdAt: string; receivedAt: string; status: CommentStatus; reason: string;
  reply: string; ruleId: string; approved: boolean; approvedText: string;
  attemptedAt: string; repliedAt: string; replyId: string;
  ai?: AiReply;
}
const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown, max = 2000) => typeof v === "string" ? v.slice(0, max) : "";
const validId = (v: string) => /^\d+(?:_\d+)?$/.test(v);
const normal = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sensitive = /\b(refund|return|cancel|broken|damaged|complaint|scam|fraud|lawsuit|lawyer|allerg\w*|pregnan\w*|diagnos\w*|disease|medic\w*|suicid\w*|bank|password|order\s*(number|id)|tracking|hate|worst|terrible|disappoint\w*|not\s+(received|arrived|working)|never\s+(received|arrived)|ignore\s+(previous|instructions))\b/i;
const privateData = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d\s()-]{7,}\d)/i;

/** Only an exact owner-approved question can receive an automatic answer. */
export function classifyComment(text: string, rules: ReplyRule[]): { reply: string; ruleId: string; reason: string } {
  if (!text.trim()) return { reply: "", ruleId: "", reason: "Attachment or empty comment needs review." };
  if (sensitive.test(text) || privateData.test(text)) return { reply: "", ruleId: "", reason: "Customer support, sensitive topic, or personal information needs review." };
  const matches = rules.filter(rule => rule.questions.some(q => normal(q) === normal(text)));
  if (matches.length !== 1) return { reply: "", ruleId: "", reason: matches.length ? "More than one approved answer matches." : "No exact approved answer. Write a reply or add this question to your approved answers." };
  return { reply: matches[0]!.reply, ruleId: matches[0]!.id, reason: "Matches an approved question." };
}

export class Engagement {
  readonly store: Store;
  readonly vault: Vault;
  readonly meta: MetaGateway;
  readonly intelligence: PageIntelligence;
  constructor(store: Store, vault: Vault, meta: MetaGateway, fetchImpl?: typeof fetch, pageFetch?: typeof publicBytes) { this.store = store; this.vault = vault; this.meta = meta; this.intelligence = new PageIntelligence(store, vault, fetchImpl, pageFetch); }
  config(brandId: string): EngagementConfig {
    return this.store.get<EngagementConfig>("engagement", brandId) ?? { id: brandId, brandId, mode: "off", dailyLimit: 50, rules: [], autoSince: "", updatedAt: "", accountId: "", pageId: "", instagramId: "", lastDiscoveryAt: "", error: "", unmappedAds: 0, subscriptions: [], aiEnabled: true, provider: "glm", model: "glm-5.2", aiDailyLimit: 100, knowledgeUrls: [] };
  }
  private brand(id: string): ManagedBrand {
    const b = this.store.get<ManagedBrand>("brands", id);
    if (!b) throw new AppError("Brand not found.", 404);
    return b;
  }
  private ready(brandId: string, send = false): { brand: ManagedBrand; config: EngagementConfig } {
    const brand = this.brand(brandId), config = this.config(brandId);
    if (config.mode === "off") throw new AppError("Engagement is turned off for this brand.", 409);
    if (brand.mode === "SIMULATE" || brand.mode === "VALIDATE") throw new AppError("Use a connected staged or live brand to collect real comments.", 409);
    if (send && (brand.mode !== "LIVE" || this.store.setting("app", DEFAULT_SETTINGS).globalPaused)) throw new AppError("Replies require a live brand and a resumed workspace.", 409);
    if (config.accountId !== brand.adAccountId || config.pageId !== brand.pageId || config.instagramId !== (brand.instagramUserId ?? "")) throw new AppError("Brand assets changed. Review and save its engagement settings again.", 409);
    this.meta.assertSelected(brand); this.meta.token();
    return { brand, config };
  }
  save(brandId: string, input: unknown): EngagementConfig {
    const b = this.brand(brandId), old = this.config(brandId), o = object(input);
    const mode = o["mode"];
    if (!["off", "review", "auto"].includes(String(mode))) throw new AppError("Choose off, review, or automatic replies.");
    const dailyLimit = Number(o["dailyLimit"]);
    const aiEnabled = o["aiEnabled"] === true, provider = String(o["provider"] ?? old.provider) as ReplyProvider, model = String(o["model"] ?? old.model), aiDailyLimit = Number(o["aiDailyLimit"] ?? old.aiDailyLimit);
    if (!(provider in ENGAGEMENT_MODELS) || !(ENGAGEMENT_MODELS[provider] as readonly string[]).includes(model)) throw new AppError("Choose a supported MiniMax or GLM model.");
    if (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 1 || aiDailyLimit > 2000) throw new AppError("Daily AI request limit must be between 1 and 2,000.");
    if (o["knowledgeUrls"] !== undefined && (!Array.isArray(o["knowledgeUrls"]) || o["knowledgeUrls"].length > 10 || o["knowledgeUrls"].some(u => typeof u !== "string"))) throw new AppError("Use at most 10 additional knowledge URLs.");
    const knowledgeUrls = [...new Set(((o["knowledgeUrls"] ?? []) as string[]).map(sourceUrl))];
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) throw new AppError("Daily reply limit must be between 1 and 500.");
    if (!Array.isArray(o["rules"]) || o["rules"].length > 50) throw new AppError("Use at most 50 approved answers.");
    const questions = new Set<string>();
    const rules = o["rules"].map((value, i) => {
      const r = object(value), label = str(r["label"], 100).trim(), reply = str(r["reply"], 1501).trim();
      if (!label || !reply || reply.length > 1500 || !Array.isArray(r["questions"]) || !r["questions"].length || r["questions"].length > 30) throw new AppError("Each answer needs a label, 1–30 example questions, and a reply of up to 1,500 characters.");
      const samples = r["questions"].map(q => {
        if (typeof q !== "string" || !normal(q) || q.length > 300) throw new AppError("Approved questions must contain 1–300 characters.");
        if (questions.has(normal(q))) throw new AppError("An example question can only belong to one approved answer.");
        questions.add(normal(q)); return q.trim();
      });
      if (b.claims.neverSay.some(claim => claim.trim() && normal(reply).includes(normal(claim)))) throw new AppError("An approved reply contains a claim excluded by this brand.");
      return { id: key(`${i}:${label}:${reply}`), label, questions: samples, reply };
    });
    if (mode !== "off") {
      if (["SIMULATE", "VALIDATE"].includes(b.mode)) throw new AppError("Connect a staged or live brand before collecting comments.");
      this.meta.assertSelected(b); this.meta.token();
      if (this.store.list<EngagementConfig>("engagement").some(c => c.id !== brandId && c.mode !== "off" && c.pageId === b.pageId)) throw new AppError("This Page already has an engagement owner in this workspace. Use that brand’s inbox to avoid duplicate replies.", 409);
      const c = metaConnection(this.store, this.vault);
      if (c.method === "oauth") {
        const required = ["ads_read", "pages_show_list", "pages_read_engagement", "pages_read_user_content", ...(mode === "auto" ? ["pages_manage_engagement"] : []), ...(b.instagramUserId ? ["instagram_basic", "instagram_manage_comments"] : [])];
        const missing = required.filter(p => !c.permissions.includes(p));
        if (missing.length) throw new AppError(`Reconnect Facebook and grant: ${missing.join(", ")}.`, 409);
      }
      if (aiEnabled && !this.vault.get(provider === "glm" ? "glmKey" : "minimaxKey")) throw new AppError(`Save your ${provider === "glm" ? "Z.AI" : "MiniMax"} API key in Connections first.`);
      if (mode === "auto" && (b.mode !== "LIVE" || (!rules.length && !aiEnabled))) throw new AppError("Automatic replies require a live brand and page intelligence or an approved answer.");
    }
    const config: EngagementConfig = { ...old, mode: mode as EngagementConfig["mode"], dailyLimit, rules, aiEnabled, provider, model, aiDailyLimit, knowledgeUrls, autoSince: mode === "auto" && (old.mode !== "auto" || old.pageId !== b.pageId || old.accountId !== b.adAccountId) ? nowIso() : old.autoSince, updatedAt: nowIso(), accountId: b.adAccountId, pageId: b.pageId, instagramId: b.instagramUserId ?? "", error: "" };
    this.store.put("engagement", config);
    if (mode !== "off") {
      this.store.enqueue("engagement-discover", brandId);
      for (const t of this.store.list<CommentThread>("commentThreads", brandId)) this.store.enqueue("comment-sync", t.id);
      if (aiEnabled) for (const p of this.store.list<PageKnowledge>("pageKnowledge", brandId)) this.store.enqueue("page-knowledge", p.id);
    }
    this.store.event(brandId, "info", "Engagement settings saved", mode === "auto" ? "Grounded AI replies and approved answers may be published within the daily limit. Uncertain conversations need review." : mode === "review" ? "Comments and draft replies are collected for review. No automatic replies." : "New comment collection and replies are stopped.");
    return config;
  }
  async discover(brandId: string): Promise<void> {
    const { brand: b } = this.ready(brandId);
    const ads = await this.meta.list(`${b.adAccountId}/ads`, { fields: "id,name,creative{actor_id,instagram_user_id,effective_object_story_id,effective_instagram_media_id,object_story_spec,asset_feed_spec,link_url,body,title,call_to_action_type}" }, b.adAccountId);
    const threads = new Map<string, CommentThread>(); let unmapped = 0;
    for (const ad of ads) {
      const c = object(ad["creative"]), post = str(c["effective_object_story_id"]), media = str(c["effective_instagram_media_id"]);
      const belongs = str(c["actor_id"]) === b.pageId || post.startsWith(`${b.pageId}_`);
      if (!belongs) continue;
      const spec = object(c["object_story_spec"]), link = object(spec["link_data"]), video = object(spec["video_data"]), template = object(spec["template_data"]);
      const action = object(link["call_to_action"] ?? video["call_to_action"] ?? template["call_to_action"]), actionValue = object(action["value"]);
      const formId = str(actionValue["lead_gen_form_id"]), actionType = str(action["type"] ?? c["call_to_action_type"]);
      const urls = [link["link"], template["link"], actionValue["link"], c["link_url"], ...(Array.isArray(object(c["asset_feed_spec"])["link_urls"]) ? (object(c["asset_feed_spec"])["link_urls"] as unknown[]).map(v => object(v)["website_url"]) : [])].filter(v => typeof v === "string" && v.startsWith("https://")) as string[];
      const cta = /MESSAGE|WHATSAPP|CHAT/.test(actionType) || /messeng|whatsapp|instagram_direct/.test(b.archetype) ? "message" : formId || /lead/.test(b.archetype) ? "form" : "visit";
      const messageChannel = /WHATSAPP/.test(actionType) || b.archetype === "whatsapp_conversation" ? "whatsapp" : /INSTAGRAM/.test(actionType) ? "instagram" : "messenger";
      if (!urls.length && b.destination.url && cta !== "message" && !formId) urls.push(b.destination.url);
      const destinationUrls = [...new Set(urls.map(sourceUrl))];
      const adText = [c["title"], c["body"], link["message"], link["name"], link["description"], video["message"]].filter(v => typeof v === "string").join("\n").slice(0, 6000);
      let found = false;
      for (const [platform, remoteId, actorId] of [["facebook", post, b.pageId], ["instagram", media, b.instagramUserId ?? ""]] as const) {
        if (!validId(remoteId) || !actorId || (platform === "instagram" && str(c["instagram_user_id"]) && str(c["instagram_user_id"]) !== actorId)) continue;
        found = true; const id = key(`${platform}:${remoteId}`);
        const previous = this.store.get<CommentThread>("commentThreads", id);
        if (previous && previous.brandId !== brandId && this.config(previous.brandId).mode !== "off") throw new AppError("An ad post is already managed by another brand.", 409);
        const t = threads.get(id) ?? { id, brandId, platform, remoteId, pageId: b.pageId, actorId, adName: str(ad.name, 200) || ad.id, adIds: [], lastSyncedAt: previous?.lastSyncedAt ?? "", error: previous?.error ?? "", destinationUrls: [], adText, cta: cta as CommentThread["cta"], formId };
        if (t.adIds.length && (t.cta !== cta || t.formId !== formId || JSON.stringify(t.destinationUrls) !== JSON.stringify(destinationUrls))) t.ambiguousDestination = true;
        t.messageChannel = messageChannel;
        t.destinationUrls = [...new Set([...t.destinationUrls, ...destinationUrls])];
        t.adIds.push(ad.id); threads.set(id, t);
      }
      if (!found || (b.instagramUserId && !media)) unmapped++;
    }
    this.ready(brandId); // Do not persist a discovery completed after access was disabled.
    if (this.config(brandId).aiEnabled) for (const url of new Set([...threads.values()].flatMap(t => t.destinationUrls).concat(this.config(brandId).knowledgeUrls))) this.intelligence.enqueue(brandId, url);
    for (const t of threads.values()) { this.store.put("commentThreads", t); this.store.enqueue("comment-sync", t.id, Date.now(), false); }
    const config = this.config(brandId);
    this.store.put("engagement", { ...config, lastDiscoveryAt: nowIso(), unmappedAds: unmapped, error: unmapped ? `${unmapped} ${unmapped === 1 ? "ad does" : "ads do"} not expose post IDs for every possible placement. Review their placements in Meta.` : "" });
    // Retained post IDs continue to be checked after an ad is paused or archived.
    for (const t of this.store.list<CommentThread>("commentThreads", brandId)) this.store.enqueue("comment-sync", t.id, Date.now(), false);
  }
  private async list(t: CommentThread, path: string, fields: string, extra: Record<string, string> = {}): Promise<GraphNode[]> {
    const result: GraphNode[] = [], seen = new Set<string>(); let params = { fields, limit: "100", ...extra };
    for (let i = 0; i < 100; i++) {
      const cursor = JSON.stringify(params);
      if (seen.has(cursor)) throw new AppError("Meta returned a repeating comment page.");
      seen.add(cursor);
      const b = this.ready(t.brandId).brand;
      const response = await this.meta.pageRequest<{ data?: GraphNode[]; paging?: { next?: string } }>(t.pageId, "GET", path, params, b.adAccountId);
      if (!Array.isArray(response.data)) throw new AppError("Meta returned an incomplete comment list.");
      result.push(...response.data);
      if (!response.paging?.next) return result;
      const next = parseNextPage(response.paging.next);
      if (next.path.replace(/^\//, "") !== path) throw new AppError("Meta returned a different comment endpoint during pagination.");
      const { access_token: _token, appsecret_proof: _proof, ...safe } = next.params;
      params = { fields, limit: "100", ...extra, ...safe };
    }
    throw new AppError("Comment coverage is incomplete: more than 10,000 items in one thread. Review this post in Meta.");
  }
  private fields(t: CommentThread) { return t.platform === "facebook" ? "id,message,from,parent,created_time,is_hidden" : "id,text,from,timestamp,hidden"; }
  private async replies(t: CommentThread, commentId: string) {
    return this.list(t, `${commentId}/${t.platform === "facebook" ? "comments" : "replies"}`, this.fields(t));
  }
  ingest(t: CommentThread, node: GraphNode, parentId = ""): AdComment | undefined {
    this.ready(t.brandId);
    if (!validId(node.id)) return;
    const id = key(`${t.platform}:${node.id}`), old = this.store.get<AdComment>("comments", id);
    const author = object(node["from"]), authorId = str(author["id"]);
    const text = str(node[t.platform === "facebook" ? "message" : "text"], 10000);
    const created = str(node[t.platform === "facebook" ? "created_time" : "timestamp"]);
    const createdAt = Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : "";
    const config = this.config(t.brandId), match = classifyComment(text, config.rules);
    const self = [t.actorId, t.pageId].includes(authorId);
    const changed = old && old.text !== text;
    if (old && old.brandId !== t.brandId) return old; // A shared post still gets only one reply.
    const c: AdComment = old ? { ...old, text, author: str(author["name"] ?? author["username"], 200), authorId } : {
      id, brandId: t.brandId, threadId: t.id, platform: t.platform, remoteId: node.id,
      parentId: parentId || str(object(node["parent"])["id"]), authorId,
      author: str(author["name"] ?? author["username"], 200) || "Facebook / Instagram user", text, createdAt, receivedAt: nowIso(),
      status: "review", reason: match.reason, reply: match.reply, ruleId: match.ruleId, approved: false, approvedText: "", attemptedAt: "", repliedAt: "", replyId: "",
    };
    if (self || node["is_hidden"] === true || node["hidden"] === true) { c.status = "ignored"; c.reason = self ? "A reply from your own account." : "Hidden comment. No reply will be posted."; }
    else if (changed && ["review", "queued", "failed"].includes(c.status)) { c.status = "review"; c.reason = "The comment was edited. Review its current wording."; c.approved = false; c.reply = ""; }
    else if (!old && authorId && match.reply && config.mode === "auto" && createdAt && createdAt >= config.autoSince) { c.status = "queued"; c.approvedText = text; }
    if (!authorId && !old) { c.status = "review"; c.reason = "Author identity is unavailable; automatic replies are disabled."; }
    this.store.put("comments", c);
    if (c.status === "queued") this.store.enqueue("comment-reply", c.id, Date.now() + 10000, false);
    if (!old && c.status === "review" && authorId && !sensitive.test(text) && !privateData.test(text) && text.trim() && config.aiEnabled) this.store.enqueue("comment-draft", c.id, Date.now() + 15000, false);
    if (self && c.parentId) {
      const parent = this.store.get<AdComment>("comments", key(`${t.platform}:${c.parentId}`));
      if (parent && !["replied", "ignored", "deleted"].includes(parent.status)) this.answered(parent, c.remoteId);
    }
    return c;
  }
  async sync(threadId: string): Promise<void> {
    const t = this.store.get<CommentThread>("commentThreads", threadId); if (!t) return;
    this.ready(t.brandId);
    try {
      if (t.platform === "instagram") {
        const owner = await this.meta.pageRequest<{ id: string; owner?: { id?: string }; permalink?: string }>(t.pageId, "GET", t.remoteId, { fields: "id,owner,permalink" }, this.brand(t.brandId).adAccountId);
        if (owner.id !== t.remoteId || owner.owner?.id !== t.actorId) throw new AppError("Instagram media ownership could not be verified.", 403);
        if (owner.permalink && /^https:\/\/(?:www\.)?instagram\.com\//.test(owner.permalink)) t.permalinkUrl = owner.permalink;
      }
      const nodes = await this.list(t, `${t.remoteId}/comments`, this.fields(t), t.platform === "facebook" ? { filter: "stream" } : {});
      // Parents first: detecting an existing Page reply must cancel a pending automatic answer.
      const ordered = [...nodes].sort((a, b) => Number(Boolean(object(a["parent"])["id"])) - Number(Boolean(object(b["parent"])["id"])));
      for (const node of ordered) {
        this.ingest(t, node);
        if (t.platform === "instagram") for (const reply of await this.replies(t, node.id)) this.ingest(t, reply, node.id);
      }
      if (this.store.get("commentThreads", t.id)) this.store.put("commentThreads", { ...t, lastSyncedAt: nowIso(), error: "" });
    } catch (error) {
      if (this.store.get("commentThreads", t.id)) this.store.put("commentThreads", { ...t, error: this.vault.redact(String(error)).slice(0, 1000) }); throw error;
    }
  }
  private answered(c: AdComment, replyId: string) {
    c.status = "answered"; c.reason = "Your Page or Instagram account has already responded."; c.replyId = replyId; c.repliedAt ||= nowIso();
    this.store.put("comments", c);
  }
  approve(id: string, reply: unknown): void {
    const c = this.store.get<AdComment>("comments", id); if (!c) throw new AppError("Comment not found.", 404);
    this.ready(c.brandId, true);
    if (!["review", "failed"].includes(c.status)) throw new AppError("This comment cannot receive another reply. Check its current status.", 409);
    if (typeof reply !== "string" || !reply.trim() || reply.length > 1500) throw new AppError("Write a reply of 1–1,500 characters.");
    if (!c.authorId) throw new AppError("Review this comment directly in Meta because its author could not be verified.");
    c.reply = reply.trim(); c.approved = true; c.approvedText = c.text; c.status = "queued"; c.reason = "Owner approved this public reply.";
    this.store.put("comments", c); this.store.enqueue("comment-reply", c.id);
  }
  dismiss(id: string): void {
    const c = this.store.get<AdComment>("comments", id); if (!c) throw new AppError("Comment not found.", 404);
    if (c.status === "sending") throw new AppError("This reply is being sent. Refresh to see the outcome.", 409);
    c.status = "ignored"; c.reason = "Closed by the workspace owner."; this.store.put("comments", c);
  }
  async send(id: string): Promise<number | undefined> {
    let c = this.store.get<AdComment>("comments", id); if (!c || !["queued", "sending"].includes(c.status)) return;
    const { brand: b, config } = this.ready(c.brandId, true);
    const t = this.store.get<CommentThread>("commentThreads", c.threadId); if (!t || t.brandId !== c.brandId || t.pageId !== b.pageId) throw new AppError("The comment no longer belongs to this brand.");
    const fresh = await this.meta.pageRequest<GraphNode>(t.pageId, "GET", c.remoteId, { fields: this.fields(t) }, b.adAccountId);
    if (fresh.id !== c.remoteId) throw new AppError("Meta returned a different comment.");
    const currentText = str(fresh[t.platform === "facebook" ? "message" : "text"], 10000);
    const currentAuthor = str(object(fresh["from"])["id"]);
    const replies = await this.replies(t, c.remoteId);
    const ownReply = replies.find(r => [t.actorId, t.pageId].includes(str(object(r["from"])["id"])));
    c = this.store.get<AdComment>("comments", id)!;
    if (ownReply) { this.answered(c, ownReply.id); return; }
    if (this.store.effect(`comment-reply:${id}`)?.state === "pending" || c.status === "sending") {
      c.status = "uncertain"; c.reason = "A previous send was interrupted. Check the conversation in Meta before taking further action. No duplicate will be sent."; this.store.put("comments", c); return;
    }
    if (c.status !== "queued") return;
    const latest = this.ready(c.brandId, true).config;
    const match = classifyComment(currentText, latest.rules);
    const approvedAnswer = c.approved || (c.ai ? latest.aiEnabled && c.ai.reply === c.reply && this.intelligence.validDraft(b, t, c.ai) : Boolean(match.reply && match.reply === c.reply));
    if (currentText !== c.approvedText || !currentAuthor || currentAuthor !== c.authorId || [t.actorId, t.pageId].includes(currentAuthor) || fresh["is_hidden"] === true || fresh["hidden"] === true || (!c.approved && (latest.mode !== "auto" || !approvedAnswer || !c.createdAt || c.createdAt < latest.autoSince))) {
      c.status = "review"; c.reason = "Comment, access, or approved answer changed. Review before replying."; c.approved = false; this.store.put("comments", c); return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const reserved = this.store.transaction(() => {
      const count = Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection='comments' AND brand_id=? AND json_extract(data,'$.attemptedAt') LIKE ?").get(b.id, `${day}%`)?.["n"] ?? 0);
      if (count >= config.dailyLimit) return false;
      if (!this.store.startEffect(`comment-reply:${id}`)) return false;
      c!.status = "sending"; c!.attemptedAt = nowIso(); this.store.put("comments", c!); return true;
    });
    if (!reserved) { c.status = "review"; c.reason = "Daily reply allowance reached, or this reply was already attempted."; this.store.put("comments", c); return; }
    let postStarted = false;
    try {
      const result = await this.meta.pageRequest<{ id?: string }>(t.pageId, "POST", `${c.remoteId}/${t.platform === "facebook" ? "comments" : "replies"}`, { message: c.reply }, b.adAccountId, () => {
        const config = this.ready(b.id, true).config, current = this.store.get<AdComment>("comments", id);
        if (!current || current.status !== "sending" || (!current.approved && config.mode !== "auto")) throw new AppError("This public reply was stopped before sending.", 409);
        if (current.ai && !current.approved && !this.intelligence.validDraft(b, this.store.get<CommentThread>("commentThreads", t.id)!, current.ai)) throw new AppError("The source knowledge changed before sending.", 409);
        postStarted = true;
      });
      if (!result.id || !validId(result.id)) throw new Error("Meta did not confirm a reply ID.");
      if (!this.store.get("comments", id)) return;
      c.status = "replied"; c.replyId = result.id; c.repliedAt = nowIso(); c.reason = c.approved ? "Public reply approved by the owner." : c.ai ? `Verified public reply from ${c.ai.model}.` : "Public reply from an approved answer.";
      this.store.finishEffect(`comment-reply:${id}`, { replyId: result.id }); this.store.put("comments", c);
      this.store.event(b.id, "success", "Ad comment answered", `${t.platform === "facebook" ? "Facebook" : "Instagram"} · ${t.adName}`);
    } catch (error) {
      this.meta.recordAuthError(error);
      if (!this.store.get("comments", id)) return;
      if (!postStarted && !(error instanceof RateLimited)) {
        this.store.failEffect(`comment-reply:${id}`, "Stopped before any public request."); c.status = "review"; c.reason = this.vault.redact(String(error)); this.store.put("comments", c); return;
      }
      if (error instanceof RateLimited || (error instanceof MetaApiError && error.disposition === "THROTTLED")) {
        this.store.failEffect(`comment-reply:${id}`, "Meta rate limit; no reply accepted."); c.status = "queued"; c.reason = "Waiting for Meta’s rate limit to reset."; this.store.put("comments", c);
        return Date.now() + (error instanceof RateLimited ? error.retryAfterMs : 60000);
      }
      const definite = error instanceof MetaApiError && ["AUTH_FAILED", "PERMANENT", "ACCOUNT_BLOCKED"].includes(error.disposition) && error.httpStatus < 500;
      c.status = definite ? "failed" : "uncertain";
      c.reason = this.vault.redact(String(error)).slice(0, 700) + (definite ? " Correct access or permissions, then review the reply." : " Delivery could not be confirmed. Check Meta; this reply will not be sent again automatically.");
      if (definite) this.store.failEffect(`comment-reply:${id}`, "Meta rejected the reply.");
      this.store.put("comments", c); this.store.event(b.id, "error", "Comment reply needs review", c.reason);
    }
  }
  async subscribe(brandId: string): Promise<void> {
    const { brand: b } = this.ready(brandId);
    const c = metaConnection(this.store, this.vault);
    if (c.method === "oauth" && !c.permissions.includes("pages_manage_metadata")) throw new AppError("Reconnect Facebook with pages_manage_metadata before subscribing.");
    if (!this.vault.get("metaWebhookVerifyToken")) throw new AppError("Save a webhook verification token in Connections and configure the callback in your Meta app first.");
    const result = await this.meta.pageRequest<{ success?: boolean }>(b.pageId, "POST", `${b.pageId}/subscribed_apps`, { subscribed_fields: "feed" }, b.adAccountId);
    if (!result.success) throw new AppError("Meta did not confirm the Page subscription.");
    this.store.put("engagement", { ...this.config(brandId), subscriptions: ["Facebook feed"] });
  }
  async draft(id: string): Promise<void> {
    const c = this.store.get<AdComment>("comments", id); if (!c || c.status !== "review" || c.approved || c.ai) return;
    const { brand: b } = this.ready(c.brandId), t = this.store.get<CommentThread>("commentThreads", c.threadId);
    if (!t || !this.config(b.id).aiEnabled || sensitive.test(c.text) || privateData.test(c.text)) return;
    const ai = await this.intelligence.draft(b, t, c);
    const current = this.store.get<AdComment>("comments", id), config = this.ready(b.id).config;
    if (!current || current.status !== "review" || current.text !== c.text || current.approved || !config.aiEnabled || config.model !== ai.model || config.provider !== ai.provider) return;
    current.ai = ai; current.reply = ai.reply; current.approvedText = c.text; current.reason = `Grounded draft from ${ai.model}.`;
    if (config.mode === "auto" && current.createdAt && current.createdAt >= config.autoSince && b.mode === "LIVE") current.status = "queued";
    this.store.put("comments", current); if (current.status === "queued") this.store.enqueue("comment-reply", id);
  }
  queueDraft(id: string): void {
    const c = this.store.get<AdComment>("comments", id); if (!c) throw new AppError("Comment not found.", 404);
    this.ready(c.brandId); this.intelligence.config(c.brandId);
    if (c.status !== "review" || c.attemptedAt) throw new AppError("Only an unsent comment awaiting review can be drafted again.", 409);
    delete c.ai; c.reply = ""; c.approved = false; c.reason = "Waiting for a contextual AI draft.";
    this.store.put("comments", c); this.store.enqueue("comment-draft", id);
  }
  webhook(raw: Buffer, signature: string): void {
    const secret = this.vault.get("metaAppSecret"), expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new AppError("Invalid Meta webhook signature.", 403);
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(raw.toString("utf8"))); } catch { throw new AppError("Invalid webhook JSON."); }
    if (!["page", "instagram"].includes(String(payload["object"])) || !Array.isArray(payload["entry"])) return;
    for (const entry of payload["entry"].slice(0, 1000)) {
      const e = object(entry), ownerId = str(e["id"]);
      for (const config of this.store.list<EngagementConfig>("engagement").filter(c => c.mode !== "off" && (c.pageId === ownerId || c.instagramId === ownerId))) {
        this.store.enqueue("engagement-discover", config.brandId);
        for (const t of this.store.list<CommentThread>("commentThreads", config.brandId)) this.store.enqueue("comment-sync", t.id);
        for (const change of Array.isArray(e["changes"]) ? e["changes"] : []) {
          const v = object(object(change)["value"]);
          if (v["verb"] === "remove" && validId(str(v["comment_id"]))) {
            const comment = this.store.get<AdComment>("comments", key(`facebook:${str(v["comment_id"])}`));
            if (comment?.brandId === config.brandId && comment.status !== "sending") this.store.put("comments", { ...comment, status: "deleted", reason: "Meta reported this comment was removed." });
          }
        }
      }
    }
    this.store.setSetting("lastCommentWebhookAt", nowIso());
  }
  comments(brandId = "", status = "all", offset = 0) {
    const where = "collection='comments' AND (?='' OR brand_id=?) AND (?='all' OR (?='attention' AND json_extract(data,'$.status') IN ('review','uncertain','failed')) OR json_extract(data,'$.status')=?)";
    const args = [brandId, brandId, status, status, status];
    const total = Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${where}`).get(...args)?.["n"] ?? 0);
    const items = this.store.db.prepare(`SELECT data FROM documents WHERE ${where} ORDER BY json_extract(data,'$.receivedAt') DESC,id LIMIT 100 OFFSET ?`).all(...args, offset).map(r => JSON.parse(String(r["data"])) as AdComment);
    return { items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  failure(kind: string, id: string, reason: string, retrying: boolean): void {
    if (kind === "engagement-discover" && this.store.get("engagement", id)) this.store.put("engagement", { ...this.config(id), error: reason });
    if (kind === "comment-reply" || kind === "comment-draft") {
      const c = this.store.get<AdComment>("comments", id);
      if (c && ["queued", "review"].includes(c.status)) this.store.put("comments", { ...c, status: retrying ? c.status : "review", reason });
    }
  }
  snapshot() {
    const counts = this.store.db.prepare("SELECT json_extract(data,'$.status') AS status, COUNT(*) AS n FROM documents WHERE collection='comments' GROUP BY status").all();
    return { configs: this.store.list<EngagementConfig>("engagement"), threads: this.store.list<CommentThread>("commentThreads"), pages: this.store.list<PageKnowledge>("pageKnowledge").map(({ text: _text, ...p }) => p), models: ENGAGEMENT_MODELS, usage: this.store.db.prepare("SELECT brand_id AS brandId,COUNT(*) AS requests,SUM(tokens) AS tokens FROM engagement_ai_usage WHERE day=? GROUP BY brand_id").all(nowIso().slice(0, 10)), counts: Object.fromEntries(counts.map(r => [String(r["status"]), Number(r["n"])])), lastWebhookAt: this.store.setting("lastCommentWebhookAt", "") };
  }
}
