// Remote rule-sets a rule refers to: a SagerNet file name (`geosite-openai`, `geoip-us`), which
// becomes its raw.githubusercontent.com URL, or the URL of any rule-set.

import { GEOIP_NAMES, GEOSITE_NAMES } from "./rule-set-names";
import type { RuleSetContent, RuleSetRef } from "./types";

export type RuleSetKind = "geosite" | "geoip";

export const RULE_SET_REPOS: Record<RuleSetKind, { repo: string; browse: string; content: RuleSetContent }> = {
  geosite: { repo: "SagerNet/sing-geosite", browse: "https://github.com/SagerNet/sing-geosite/tree/rule-set", content: "domain" },
  geoip: { repo: "SagerNet/sing-geoip", browse: "https://github.com/SagerNet/sing-geoip/tree/rule-set", content: "ip" },
};

const KNOWN: Record<RuleSetKind, Set<string>> = { geosite: new Set(GEOSITE_NAMES), geoip: new Set(GEOIP_NAMES) };

export const sagerNetUrl = (kind: RuleSetKind, name: string) =>
  `https://raw.githubusercontent.com/${RULE_SET_REPOS[kind].repo}/rule-set/${kind}-${name}.srs`;

/** A reference as it goes into the config. */
export interface ResolvedRuleSet {
  url: string;
  /** `binary` for .srs (and anything not .json), `source` for .json. */
  format: "binary" | "source";
  content: RuleSetContent;
  /** The SagerNet set it names, if any. */
  sagerNet?: { kind: RuleSetKind; name: string; known: boolean };
  /** Tag it would like: the file name without extension. */
  baseTag: string;
}

const NAME_RE = /^(geosite|geoip)-([a-z0-9][a-z0-9!@._-]*)$/;
const SAGERNET_URL_RE = /^https:\/\/raw\.githubusercontent\.com\/SagerNet\/sing-(geosite|geoip)\/(?:refs\/heads\/)?rule-set\/((?:geosite|geoip)-[^/?#]+)\.srs$/i;
/** github.com page of a file, as copied from the browser: blob → raw. */
const GITHUB_BLOB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i;

/** The text as typed, made canonical: `geosite:openai`, `geosite-openai.srs`, SagerNet links → `geosite-openai`; github.com pages → raw links. */
export function canonicalSource(text: string): string {
  let s = text.trim();
  const blob = GITHUB_BLOB_RE.exec(s);
  if (blob) s = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  const sn = SAGERNET_URL_RE.exec(s);
  if (sn && sn[2].toLowerCase().startsWith(`${sn[1].toLowerCase()}-`)) return sn[2].toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return s
    .toLowerCase()
    .replace(/^(geosite|geoip):/, "$1-")
    .replace(/\.srs$/, "");
}

/** What a reference resolves to, or why it does not. */
export function resolveRuleSet(ref: RuleSetRef): ResolvedRuleSet | { problem: string } {
  const source = canonicalSource(ref.source);
  if (!source) return { problem: "为空" };
  const m = NAME_RE.exec(source);
  if (m) {
    const kind = m[1] as RuleSetKind;
    const name = m[2];
    return {
      url: sagerNetUrl(kind, name),
      format: "binary",
      content: RULE_SET_REPOS[kind].content,
      sagerNet: { kind, name, known: KNOWN[kind].has(name) },
      baseTag: `${kind}-${name}`,
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return { problem: "链接格式不正确" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "只支持 http 和 https 链接" };
    const file = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (!file) return { problem: "链接要指向规则集文件，例如 …/my-list.srs" };
    const stem = file.replace(/\.(srs|json)$/i, "");
    return {
      url: source,
      format: /\.json$/i.test(file) ? "source" : "binary",
      content: ref.content,
      baseTag: stem.replace(/[^\w!@.-]+/g, "-").replace(/^-+|-+$/g, "") || "rule-set",
    };
  }
  if (/\s/.test(source)) return { problem: "名称里不能有空格" };
  if (/^[a-z]{2}$/.test(source) && KNOWN.geoip.has(source)) return { problem: `国家或地区的 IP 写成 geoip-${source}` };
  if (KNOWN.geosite.has(source)) return { problem: `写成 geosite-${source}` };
  return { problem: "填 geosite-名称、geoip-国家代码，或规则集的链接" };
}

/** A rule-set entry to search: its full name, and for geoip the region name in Chinese. */
export interface RuleSetSuggestion {
  source: string;
  kind: RuleSetKind;
  label?: string;
}

let regionNames: Intl.DisplayNames | null | undefined;
function regionName(code: string): string | undefined {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  if (!regionNames) return;
  try {
    const name = regionNames.of(code.toUpperCase());
    return name && name.toUpperCase() !== code.toUpperCase() ? name : undefined;
  } catch {
    return;
  }
}

let all: RuleSetSuggestion[] | undefined;
const suggestions = (): RuleSetSuggestion[] =>
  (all ??= [
    ...GEOSITE_NAMES.map((n) => ({ source: `geosite-${n}`, kind: "geosite" as const })),
    ...GEOIP_NAMES.map((n) => ({ source: `geoip-${n}`, kind: "geoip" as const, label: regionName(n) })),
  ]);

/**
 * Bundled names matching the query: exact name first, then names starting with it, then the rest
 * containing it; geoip also matches by region name (`美国` → geoip-us).
 */
export function searchRuleSets(query: string, limit = 8): RuleSetSuggestion[] {
  const q = canonicalSource(query);
  if (!q || q.includes("://")) return [];
  const bare = q.replace(/^(geosite|geoip)-/, "");
  const scored = suggestions().flatMap((x) => {
    const name = x.source.slice(x.kind.length + 1);
    const score =
      x.source === q || name === q
        ? 0
        : x.source.startsWith(q) || name.startsWith(bare)
          ? 1
          : x.source.includes(q) || name.includes(bare)
            ? 2
            : x.label?.includes(query.trim())
              ? 1
              : -1;
    // A typed prefix keeps to its kind.
    if (score < 0 || (q.startsWith("geoip-") && x.kind !== "geoip") || (q.startsWith("geosite-") && x.kind !== "geosite")) return [];
    return [{ x, score }];
  });
  return scored
    .sort((a, b) => a.score - b.score || a.x.source.length - b.x.source.length || a.x.source.localeCompare(b.x.source))
    .slice(0, limit)
    .map((s) => s.x);
}

/** Starting points offered while the search box is empty. */
export const POPULAR_RULE_SETS = [
  "geosite-openai",
  "geosite-anthropic",
  "geosite-category-ai-!cn",
  "geosite-google",
  "geosite-youtube",
  "geosite-netflix",
  "geosite-telegram",
  "geosite-github",
  "geosite-apple",
  "geoip-us",
  "geoip-jp",
];

/** Where to read what a SagerNet set contains: geosite comes from v2fly/domain-list-community. */
export function ruleSetSourcePage(r: ResolvedRuleSet): string | undefined {
  if (!r.sagerNet) return;
  if (r.sagerNet.kind === "geoip") return RULE_SET_REPOS.geoip.browse;
  return `https://github.com/v2fly/domain-list-community/blob/master/data/${r.sagerNet.name.split("@")[0]}`;
}
