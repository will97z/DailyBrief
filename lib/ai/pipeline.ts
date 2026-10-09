import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { SYSTEM_PROMPT_DIGEST_EN, SYSTEM_PROMPT_DIGEST_ZH } from "./prompts";
import { REPORT_LOCALE } from "../sources/registry";
import type { Category, RawArticle } from "../sources/types";

const SYSTEM_PROMPT_DIGEST =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_DIGEST_EN : SYSTEM_PROMPT_DIGEST_ZH;

export interface BriefItem {
  title: string;
  url: string;
  source: string;
  summary: string;
  importance: number;
}

export interface DailyReport {
  hero_headline: string;
  daily_overview: string;
  tech_briefs: BriefItem[];
  finance_briefs: BriefItem[];
  politics_briefs: BriefItem[];
  editor_note: string;
  keywords: string[];
  /** Optional trading-signals section, present when scripts/daily.ts ran successfully. */
  trading?: TradingSection;
}

import type { TickerAnalysis } from "../trading/signals";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TradingCommentary } from "./trading-commentary";

export interface TradingSection extends TradingCommentary {
  generated_at: string;
  tickers: TickerAnalysis[];
  crypto_fear_greed?: FearGreedSnapshot;
  crypto_global?: CryptoGlobalStats;
}

export interface ArticleInput extends RawArticle {
  source: string;
}

const PER_CATEGORY_LIMIT: Record<Category, number> = {
  tech: 28,
  finance: 30,
  politics: 24,
};

// Morning-market intelligence should be fresh. Older stories are useful only
// when a source does not provide a timestamp; the primary selection window is
// the last 48 hours rather than the original 14 days.
const MAX_AGE_DAYS = 2;

function selectRoundRobin(
  items: ArticleInput[],
  limit: number,
): ArticleInput[] {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const fresh = items.filter(
    (it) => !it.publishedAt || it.publishedAt.getTime() >= cutoff,
  );

  const bySource = new Map<string, ArticleInput[]>();
  for (const it of fresh) {
    const arr = bySource.get(it.sourceId) ?? [];
    arr.push(it);
    bySource.set(it.sourceId, arr);
  }
  for (const arr of bySource.values()) {
    arr.sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );
  }

  const buckets = Array.from(bySource.values());
  const out: ArticleInput[] = [];
  let madeProgress = true;
  while (out.length < limit && madeProgress) {
    madeProgress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      out.push(b.shift()!);
      madeProgress = true;
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function callOnce(userPayloadJson: string): Promise<DailyReport> {
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          "**Output language: ENGLISH ONLY.** Every string value in the JSON must be written entirely in English.",
          "",
          "Generate today's GLOBAL MARKETS MORNING NOTE from the candidate news below.",
          "This is an investment-intelligence product, not a generic news digest.",
          "**The response MUST be one valid JSON object** — starts with {, ends with }, no markdown, no code fences, no explanations.",
          "",
          "Required fields:",
          "  - hero_headline: 10-25 words; the single market-defining headline",
          "  - daily_overview: 150-220 words; TOP LINES covering risk tone, rates/policy/geopolitics, strongest structural theme and biggest risk",
          "  - tech_briefs: 3-5 items; AI/GitHub/semis/data centers/aerospace/advanced technology with investor read-through",
          "  - finance_briefs: 4-6 items; cross-asset/equities/rates/commodities/China read-through and actionable market implications",
          "  - politics_briefs: 3-5 items; Trump/Washington/U.S.-China/geopolitics with policy-vs-rhetoric distinction",
          "  - editor_note: 40-80 words; BOTTOM LINE + one underpriced second-order idea",
          "  - keywords: 6-10 market-relevant keywords",
          "",
          "BriefItem fields: title, url, source, summary, importance (1-10).",
          "Every summary should compress: WHAT HAPPENED → WHY MARKETS CARE → ASSETS/SECTORS EXPOSED.",
          "Use candidate URLs verbatim. Never invent a link.",
          "Do not include low-signal lifestyle, celebrity, sports, or generic technology stories unless they have clear market impact.",
          "No trailing commas.",
          "",
          `Candidate news (JSON array, ${userPayloadJson.length} chars):`,
          userPayloadJson,
        ].join("\n")
      : [
          "根据下方候选新闻生成今天的 GLOBAL MARKETS MORNING NOTE。",
          "这是一份投资情报产品，不是普通新闻摘要。",
          "**响应必须是一个合法 JSON 对象**——不要 markdown、代码围栏或解释。",
          "",
          "必须包含：",
          "  - hero_headline：10-25 字，今天最重要的市场主线",
          "  - daily_overview：150-220 字，像投行晨会 Top Lines，说明风险基调、政策/利率/地缘变量、最大风险和最强结构性主题",
          "  - tech_briefs：3-5 条，聚焦 AI/GitHub/半导体/数据中心/航天/先进技术及其投资映射",
          "  - finance_briefs：4-6 条，聚焦跨资产、美股、利率、商品、A股映射和投资影响",
          "  - politics_briefs：3-5 条，聚焦 Trump/华盛顿/中美关系/地缘政治，并区分政策言论与正式执行",
          "  - editor_note：40-80 字，Bottom Line + 一个市场可能低估的二阶机会",
          "  - keywords：6-10 个关键词",
          "",
          "每条 BriefItem 必须包含 title、url、source、summary、importance(1-10)。",
          "summary 压缩表达：发生了什么 → 为什么市场在意 → 哪些资产/行业受影响。",
          "url 必须原样使用候选链接，禁止编造。",
          "",
          "候选新闻（JSON 数组，共 " + userPayloadJson.length + " 字符）：",
          userPayloadJson,
        ].join("\n");

  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT_DIGEST,
    userPrompt,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<DailyReport>;
  try {
    parsed = JSON.parse(cleaned) as Partial<DailyReport>;
  } catch (strictErr) {
    try {
      const repaired = jsonrepair(cleaned);
      parsed = JSON.parse(repaired) as Partial<DailyReport>;
      console.warn("[pipeline] JSON.parse failed but jsonrepair recovered");
    } catch {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/claude-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/claude-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[pipeline] both JSON.parse and jsonrepair failed; raw at logs/claude-raw-${ts}.txt`,
        );
      } catch {
        // best-effort logging
      }
      throw strictErr;
    }
  }
  validateDailyReport(parsed, JSON.parse(userPayloadJson));
  return {
    hero_headline: parsed.hero_headline ?? "",
    daily_overview: parsed.daily_overview ?? "",
    tech_briefs: parsed.tech_briefs ?? [],
    finance_briefs: parsed.finance_briefs ?? [],
    politics_briefs: parsed.politics_briefs ?? [],
    editor_note: parsed.editor_note ?? "",
    keywords: parsed.keywords ?? [],
  };
}

export function validateDailyReport(report: Partial<DailyReport>, candidates: Array<{category: Category; url: string}>): void {
  for (const field of ["hero_headline", "daily_overview", "editor_note"] as const) {
    if (typeof report[field] !== "string" || !report[field]!.trim()) {
      throw new Error(`Incomplete LLM report: ${field} must be a nonempty string`);
    }
  }
  if (!Array.isArray(report.keywords) || !report.keywords.length || report.keywords.some(k => typeof k !== "string" || !k.trim())) {
    throw new Error("Incomplete LLM report: keywords must contain strings");
  }
  const urls = new Set(candidates.map(a => a.url));
  for (const category of ["tech", "finance", "politics"] as const) {
    const field = `${category}_briefs` as const;
    const items = report[field];
    if (!Array.isArray(items) || (candidates.some(a => a.category === category) && !items.length)) {
      throw new Error(`Incomplete LLM report: ${field} must contain briefs for available candidates`);
    }
    for (const item of items) {
      if (!item || [item.title, item.url, item.source, item.summary].some(v => typeof v !== "string" || !v.trim()) ||
          !Number.isFinite(item.importance) || item.importance < 1 || item.importance > 10 || !urls.has(item.url)) {
        throw new Error(`Invalid LLM report: malformed or ungrounded item in ${field}`);
      }
    }
  }
}

export async function generateDailyReport(
  articles: ArticleInput[],
): Promise<{ report: DailyReport; tokensUsed: number }> {
  const grouped: Record<Category, ArticleInput[]> = {
    tech: [],
    finance: [],
    politics: [],
  };
  for (const a of articles) grouped[a.category].push(a);

  const compact = (Object.keys(grouped) as Category[]).flatMap((c) =>
    selectRoundRobin(grouped[c], PER_CATEGORY_LIMIT[c]),
  );

  const userPayload = compact.map((a, i) => ({
    n: i + 1,
    title: a.title,
    url: a.url,
    source: a.source,
    source_id: a.sourceId,
    category: a.category,
    excerpt: (a.excerpt ?? "").slice(0, 260),
    published: a.publishedAt?.toISOString() ?? "",
  }));
  const userPayloadJson = JSON.stringify(userPayload);

  let report: DailyReport;
  try {
    report = await callOnce(userPayloadJson);
  } catch (firstErr) {
    console.warn(
      `[pipeline] first LLM call failed, retrying: ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
    );
    report = await callOnce(userPayloadJson);
  }

  return { report, tokensUsed: 0 };
}
