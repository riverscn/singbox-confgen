import type { Profile, ProxyGroup, ProxyNode, RemoteDnsChoice, RemoteDnsProtocol, RemoteDnsProvider, Settings, Tailnet } from "./types";
import { ENDPOINT_TYPES, NEEDS_SERVER, NODE_TYPES, SECRET_FIELDS } from "./templates";

type Json = Record<string, unknown>;

const URL_TEST = { url: "https://www.gstatic.com/generate_204", interval: "3m", tolerance: 50, idle_timeout: "30m" };

const GFW = ["gfwlist", "gfwlist-custom-domains"];
const GFW_IPS = ["telegram-ip", "gfwlist-custom-ips"];
const CUSTOM_PROXY = ["gfwlist-custom-domains", "gfwlist-custom-ips"];
const CN_SITE = "geosite-geolocation-cn";
const CN_IP = "geoip-cn";
const CUSTOM_DIRECT = "custom-direct-domains";
const PUBLIC_V6 = ["2000::/3"];
const IPV6_CARRIERS = ["AAAA", "HTTPS", "SVCB"];
const LOCAL_DOMAINS = {
  domain: ["localhost"],
  domain_suffix: [".local", ".lan", ".localdomain", ".home.arpa", ".internal", ".intranet"],
};

export const REMOTE_DNS: Record<RemoteDnsProvider, { label: string; address: string; serverName: string }> = {
  google: { label: "Google", address: "8.8.8.8", serverName: "dns.google" },
  cloudflare: { label: "Cloudflare", address: "1.1.1.1", serverName: "cloudflare-dns.com" },
  quad9: { label: "Quad9", address: "9.9.9.9", serverName: "dns.quad9.net" },
};

const and = (rules: Json[], extra: Json = {}): Json => ({ type: "logical", mode: "and", rules, ...extra });
const or = (rules: Json[], extra: Json = {}): Json => ({ type: "logical", mode: "or", rules, ...extra });

const noPublicV6Interface: Json = { default_interface_address: PUBLIC_V6, invert: true };

const dnsTag = (t: Tailnet) => `${t.tag}-dns`;
const proxyList = (s: Settings) => parseRuleList(s.proxyRules.join("\n"));
const hasProxyDomains = (s: Settings) => proxyList(s).domains.length > 0;
const hasProxyRules = (s: Settings) => {
  const { domains, cidrs } = proxyList(s);
  return domains.length + cidrs.length > 0;
};
const hasDns = (t: Tailnet) => t.magicDns || parseDomainList(t.dnsDomains.join("\n")).domains.length > 0;

// ---------------------------------------------------------------------------
// Input parsing

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function parseCidr(text: string): string | null {
  const [addr, len, ...rest] = text.split("/");
  if (rest.length) return null;
  const v4 = IPV4_RE.test(addr);
  const v6 = !v4 && addr.includes(":") && /^[0-9a-f:.]+$/.test(addr) && addr.split("::").length <= 2;
  if (!v4 && !v6) return null;
  const max = v4 ? 32 : 128;
  if (len === undefined) return `${addr}/${max}`;
  if (!/^\d{1,3}$/.test(len) || Number(len) > max) return null;
  return `${addr}/${Number(len)}`;
}

function cleanLines(text: string): { raw: string; line: string }[] {
  return text
    .split(/[\n,]/)
    .map((raw) => ({ raw: raw.trim(), line: raw.replace(/#.*/, "").trim().toLowerCase() }))
    .filter((x) => x.line);
}

const cleanDomain = (line: string) => line.replace(/^\*?\./, "").replace(/\.$/, "");

/** Parse user input (one domain per line, `#` comments) into clean, de-duplicated suffixes. */
export function parseDomainList(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const { raw, line } of cleanLines(text)) {
    const d = cleanDomain(line);
    if (!DOMAIN_RE.test(d)) invalid.push(raw);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid };
}

/** Like parseDomainList, but lines may also be IPv4/IPv6 addresses or prefixes. */
export function parseRuleList(text: string): { domains: string[]; cidrs: string[]; invalid: string[] } {
  const domains: string[] = [];
  const cidrs: string[] = [];
  const invalid: string[] = [];
  for (const { raw, line } of cleanLines(text)) {
    const cidr = parseCidr(line);
    if (cidr) {
      if (!cidrs.includes(cidr)) cidrs.push(cidr);
      continue;
    }
    // Looks like an address (digits and dots, or has ':' or '/') but did not parse as one.
    if (/^[\d./]+$/.test(line) || /[:/]/.test(line)) {
      invalid.push(raw);
      continue;
    }
    const d = cleanDomain(line);
    if (!DOMAIN_RE.test(d)) invalid.push(raw);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, cidrs, invalid };
}

/** JSON with `//` and `/* *\/` comments (outside strings). */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripComments(text));
}

/**
 * JSONC with comments blanked out. Comments become spaces (newlines kept), so offsets in a
 * JSON.parse error point at the same place in the original text.
 */
export function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      // A line comment ends before its newline, a block comment after its "*/"; unclosed ones run to the end.
      const line = text[i + 1] === "/";
      const found = line ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const stop = found < 0 ? text.length : line ? found : found + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** Where a JSON.parse error happened, as an offset into the parsed text, when the engine says. */
export function jsonErrorOffset(message: string, text: string): number | null {
  const pos = /position (\d+)/.exec(message);
  if (pos) return Math.min(Number(pos[1]), text.length);
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (!lc) return null;
  const lines = text.split("\n");
  const line = Math.min(Number(lc[1]), lines.length) - 1;
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return Math.min(offset + Number(lc[2]) - 1, text.length);
}

/** The endpoint object a tailnet produces, or an error message. */
export function tailnetEndpoint(t: Tailnet): { endpoint?: Json; error?: string } {
  let body: unknown;
  try {
    body = parseJsonc(t.endpoint);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "必须是一个 JSON 对象" };
  // The exit node has its own field; one left in the JSON is dropped (validate() points it out).
  const { type: _type, tag: _tag, exit_node: _exit, ...rest } = body as Json;
  const exitNode = t.exitNode.trim();
  return { endpoint: { type: "tailscale", tag: t.tag, ...rest, ...(exitNode ? { exit_node: exitNode } : {}) } };
}

// ---------------------------------------------------------------------------
// DNS

/**
 * Domains whose traffic the route rules send `direct` regardless of the resolved IP.
 * Mirrors the Direct / custom direct / GFWList / Non-CN route rules below.
 */
function directByDomain(s: Settings): Json {
  return or([
    { clash_mode: "Direct" },
    and([{ clash_mode: "Global", invert: true }, { rule_set: CUSTOM_DIRECT }]),
    and([{ clash_mode: "GFWList" }, { rule_set: GFW, invert: true }]),
    and([
      { clash_mode: "Non-CN" },
      ...(hasProxyDomains(s) ? [{ rule_set: "gfwlist-custom-domains", invert: true }] : []),
      s.steam ? or([{ rule_set: CN_SITE }, { domain_suffix: ["steamcontent.com"] }]) : { rule_set: CN_SITE },
    ]),
  ]);
}

/** Custom proxy domains, outside Direct mode and unless also listed as direct. */
const proxiedByDomain: Json = and([
  { clash_mode: "Direct", invert: true },
  { rule_set: CUSTOM_DIRECT, invert: true },
  { rule_set: "gfwlist-custom-domains" },
]);

/**
 * DNS policy:
 * - Traffic that goes direct is resolved by the local (network-provided) resolver only.
 * - Non-CN mode asks the local resolver and the remote one in parallel; a domestic or private
 *   local answer wins, anything else uses the remote answer.
 * - Proxied traffic is resolved by the remote resolver through the proxy, IPv4 only: AAAA, HTTPS
 *   and SVCB are answered empty so no IPv6 address (including HTTPS `ipv6hint`) reaches the
 *   client, and every proxied connection leaves through the same server as its IPv4 peers.
 *   Connections an app makes to IPv6 on its own are not blocked; they are routed by sniffed domain.
 * - Without a public IPv6 address locally, AAAA for direct traffic is empty.
 */
function dnsRules(s: Settings): Json[] {
  const ecs = s.clientSubnet.trim() ? { client_subnet: s.clientSubnet.trim() } : {};
  const direct = directByDomain(s);
  const tailnetRules: Json[] = [
    ...s.tailnets.flatMap((t) => {
      const { domains } = parseDomainList(t.dnsDomains.join("\n"));
      return domains.length ? [{ domain_suffix: domains, action: "route", server: dnsTag(t) }] : [];
    }),
    ...s.tailnets.filter((t) => t.magicDns).map((t) => ({ preferred_by: dnsTag(t), action: "route", server: dnsTag(t) })),
  ];
  const customProxy: Json[] = hasProxyDomains(s)
    ? [
        and([{ query_type: IPV6_CARRIERS }, proxiedByDomain], { action: "predefined", rcode: "NOERROR" }),
        { ...proxiedByDomain, action: "route", server: "remote" },
      ]
    : [];
  return [
    ...tailnetRules,
    { preferred_by: "local", action: "route", server: "local" },
    { ...LOCAL_DOMAINS, action: "route", server: "local" },
    ...(s.steam ? [{ domain: ["lancache.steamcontent.com"], action: "route", server: "local" }] : []),

    // Explicit proxy list.
    ...customProxy,

    // Direct traffic.
    and([{ query_type: "AAAA" }, noPublicV6Interface, direct], { action: "predefined", rcode: "NOERROR" }),
    { ...direct, action: "route", server: "local" },

    // Non-CN mode, domain not known to be domestic: let the local answer decide.
    and([{ clash_mode: "Non-CN" }, { query_type: ["A", "AAAA"] }], {
      action: "evaluate",
      server: "local",
      tag: "local-answer",
      timeout: "500ms",
    }),
    { match_response: "local-answer", ip_is_private: true, action: "respond", race: true },
    and(
      [
        { query_type: "AAAA" },
        noPublicV6Interface,
        { match_response: "local-answer", response_rcode: "NOERROR", rule_set: CN_IP },
      ],
      { action: "predefined", rcode: "NOERROR", race: true },
    ),
    { match_response: "local-answer", response_rcode: "NOERROR", rule_set: CN_IP, action: "respond", race: true },

    // Proxied traffic: IPv4 only. The remote query is speculative so it runs alongside the local one above.
    { query_type: IPV6_CARRIERS, action: "predefined", rcode: "NOERROR" },
    { action: "evaluate", server: "remote", tag: "remote-answer", speculative: true, ...ecs },
    { match_response: "remote-answer", action: "respond" },
    { action: "predefined", rcode: "SERVFAIL" },
  ];
}

/** DNS server types usable as the remote resolver (all reached through the proxy). */
export const REMOTE_DNS_TYPES = ["tcp", "udp", "tls", "https", "quic", "h3"];

/** The custom remote DNS server, or an error message. */
export function customDnsServer(body: string): { server?: Json; error?: string } {
  let o: unknown;
  try {
    o = parseJsonc(body);
  } catch (e) {
    return { error: `JSON 有误：${(e as Error).message}` };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "必须是一个 JSON 对象" };
  const { type, tag: _tag, ...rest } = o as Json;
  if (typeof type !== "string" || !REMOTE_DNS_TYPES.includes(type)) return { error: `type 必须是以下之一：${REMOTE_DNS_TYPES.join("、")}` };
  if (!rest.server) return { error: "缺少 server" };
  return { server: { type, tag: "remote", ...rest, ...("detour" in rest ? {} : { detour: "proxy" }) } };
}

export function remoteDnsServer(provider: RemoteDnsChoice, protocol: RemoteDnsProtocol, custom = ""): Json {
  if (provider === "custom") {
    // Fall back to Google so the config stays loadable while the custom server is being edited.
    return customDnsServer(custom).server ?? remoteDnsServer("google", protocol);
  }
  const p = REMOTE_DNS[provider];
  return {
    type: protocol,
    tag: "remote",
    server: p.address,
    server_port: protocol === "tls" ? 853 : 443,
    ...(protocol === "https" ? { path: "/dns-query" } : {}),
    tls: { enabled: true, server_name: p.serverName },
    detour: "proxy",
  };
}

function dnsServers(s: Settings): Json[] {
  return [
    { type: "local", tag: "local", neighbor_domain: [".", ".lan", ".home.arpa"] },
    ...s.tailnets.filter(hasDns).map((t) => ({
      type: "tailscale",
      tag: dnsTag(t),
      endpoint: t.tag,
      ...(t.acceptDefaultResolvers ? { accept_default_resolvers: true } : {}),
      accept_search_domain: true,
    })),
    remoteDnsServer(s.remoteDns.provider, s.remoteDns.protocol, s.remoteDns.custom),
  ];
}

// ---------------------------------------------------------------------------
// Route

function routeRules(s: Settings): Json[] {
  const gfwAll = [...GFW, ...GFW_IPS];
  const tailnetTags = s.tailnets.map((t) => t.tag);
  const tailnetExtra = s.tailnets.flatMap((t) => {
    const { domains, cidrs } = parseRuleList(t.routes.join("\n"));
    if (!domains.length && !cidrs.length) return [];
    return [
      {
        ...(domains.length ? { domain_suffix: domains } : {}),
        ...(cidrs.length ? { ip_cidr: cidrs } : {}),
        action: "route",
        outbound: t.tag,
      },
    ];
  });
  return [
    // No public IPv6 locally: refuse direct CN IPv6 before the handshake so apps fall back to IPv4.
    and(
      [
        { network: ["tcp", "udp"], ip_version: 6, ip_cidr: PUBLIC_V6 },
        { rule_set: CN_IP },
        noPublicV6Interface,
        ...(tailnetTags.length ? [{ preferred_by: tailnetTags, invert: true }] : []),
        { port: 53, invert: true },
        or([{ clash_mode: "Non-CN" }, and([{ clash_mode: "GFWList" }, { rule_set: gfwAll, invert: true }])]),
      ],
      { action: "reject", method: "default", no_drop: true },
    ),
    { action: "sniff" },
    or([{ protocol: "dns" }, { port: 53 }], { action: "hijack-dns" }),
    ...(s.blockIcloudQuic
      ? [{ network: "udp", port: 443, domain: ["gateway.icloud.com"], action: "reject", method: "default", no_drop: true }]
      : []),
    ...s.tailnets.map((t) => ({ preferred_by: t.tag, action: "route", outbound: t.tag })),
    ...tailnetExtra,
    { ...LOCAL_DOMAINS, action: "route", outbound: "direct" },
    { ip_is_private: true, action: "route", outbound: "direct" },
    { clash_mode: "Direct", action: "route", outbound: "direct" },
    and([{ clash_mode: "Global", invert: true }, { rule_set: CUSTOM_DIRECT }], { action: "route", outbound: "direct" }),
    ...(hasProxyRules(s) ? [{ rule_set: CUSTOM_PROXY, action: "route", outbound: "proxy" }] : []),
    and([{ clash_mode: "GFWList" }, { rule_set: gfwAll, invert: true }], { action: "route", outbound: "direct" }),
    and(
      [
        { clash_mode: "Non-CN" },
        or([
          { rule_set: CN_SITE },
          ...(s.steam ? [{ domain_suffix: ["steamcontent.com"] }] : []),
          { ip_is_private: true },
          { rule_set: CN_IP },
        ]),
      ],
      { action: "route", outbound: "direct" },
    ),
    { clash_mode: "Global", action: "route", outbound: "proxy" },
  ];
}

const remoteRuleSet = (tag: string, url: string): Json => ({
  type: "remote",
  tag,
  format: "binary",
  url,
  update_interval: "1d",
});

// Never-matching body for empty inline rule-sets.
const NEVER = [{ domain_regex: ["a^"] }];

function ruleSets(s: Settings): Json[] {
  const direct = parseDomainList(s.directDomains.join("\n")).domains;
  const proxy = proxyList(s);
  return [
    remoteRuleSet(CN_IP, "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs"),
    remoteRuleSet(CN_SITE, "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-cn.srs"),
    remoteRuleSet("gfwlist", "https://raw.githubusercontent.com/Dreista/sing-box-rule-set-cn/rule-set/gfwlist.txt.srs"),
    {
      type: "inline",
      tag: "telegram-ip",
      rules: [
        {
          ip_cidr: [
            "91.105.192.0/23",
            "91.108.4.0/22",
            "91.108.8.0/21",
            "91.108.16.0/21",
            "91.108.36.0/22",
            "91.108.56.0/22",
            "95.161.64.0/20",
            "95.161.80.0/24",
            "95.161.84.0/22",
            "149.154.160.0/20",
            "185.76.151.0/24",
            "2001:b28:f23d::/48",
            "2001:b28:f23f::/48",
            "2001:67c:4e8::/48",
            "2001:b28:f23c::/48",
            "2a0a:f280::/32",
          ],
        },
      ],
    },
    { type: "inline", tag: "gfwlist-custom-domains", rules: proxy.domains.length ? [{ domain_suffix: proxy.domains }] : NEVER },
    { type: "inline", tag: "gfwlist-custom-ips", rules: proxy.cidrs.length ? [{ ip_cidr: proxy.cidrs }] : NEVER },
    { type: "inline", tag: CUSTOM_DIRECT, rules: direct.length ? [{ domain_suffix: direct }] : NEVER },
  ];
}

// ---------------------------------------------------------------------------
// Nodes

/** The outbound or endpoint a node produces, or an error message. */
export function nodeObject(n: ProxyNode): { object?: Json; endpoint?: boolean; error?: string } {
  let body: unknown;
  try {
    body = parseJsonc(n.body);
  } catch (e) {
    return { error: `JSON 有误：${(e as Error).message}` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "必须是一个 JSON 对象" };
  const { type, tag: _tag, ...rest } = body as Json;
  if (typeof type !== "string" || !NODE_TYPES.includes(type)) {
    return { error: `type 必须是以下之一：${NODE_TYPES.join("、")}` };
  }
  return {
    // Proxy hosts resolve through the local resolver: they are reached directly.
    object: { type, tag: n.tag, ...rest, ...("domain_resolver" in rest ? {} : { domain_resolver: "local" }) },
    endpoint: ENDPOINT_TYPES.includes(type),
  };
}

type BuiltNode = { node: ProxyNode; object: Json; endpoint: boolean };

/**
 * Tag of every outbound a group may contain, by id: nodes and tailnets that made it into the
 * config, and the groups themselves.
 */
export function memberTags(profile: Profile, nodes: BuiltNode[]): Map<string, string> {
  const tags = new Map<string, string>();
  for (const x of nodes) tags.set(x.node.id, x.node.tag);
  for (const t of profile.settings.tailnets) if (tailnetEndpoint(t).endpoint) tags.set(t.id, t.tag);
  const usable = usableGroups(profile.groups, new Set(tags.keys()));
  for (const g of profile.groups) if (usable.has(g.id)) tags.set(g.id, g.tag);
  return tags;
}

/**
 * Groups that end up with at least one member: a node or tailnet in `outboundIds`, or another
 * usable group. The rest (just added, or only holding empty groups) are left out of the config
 * rather than breaking it, since sing-box refuses an empty group.
 */
export function usableGroups(groups: ProxyGroup[], outboundIds: Set<string>): Set<string> {
  const usable = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of groups) {
      if (usable.has(g.id)) continue;
      if (g.members.some((m) => m !== g.id && (outboundIds.has(m) || usable.has(m)))) {
        usable.add(g.id);
        changed = true;
      }
    }
  }
  return usable;
}

/** A user group as an outbound; members that no longer exist are left out. */
function groupOutbound(g: ProxyGroup, tags: Map<string, string>): Json {
  const outbounds = g.members.flatMap((id) => (tags.has(id) && id !== g.id ? [tags.get(id)!] : []));
  if (g.type === "selector") {
    const def = g.defaultMember && g.members.includes(g.defaultMember) ? tags.get(g.defaultMember) : undefined;
    return { type: "selector", tag: g.tag, outbounds, ...(def ? { default: def } : {}) };
  }
  return {
    type: "urltest",
    tag: g.tag,
    outbounds,
    url: g.testUrl.trim() || URL_TEST.url,
    interval: g.interval.trim() || URL_TEST.interval,
    tolerance: g.tolerance ?? URL_TEST.tolerance,
    idle_timeout: URL_TEST.idle_timeout,
  };
}

/**
 * `proxy` is the single entry point for proxied traffic, the remote DNS and rule-set downloads; it
 * offers `auto` (every grouped node, fastest wins), the user's groups, and optionally each node.
 */
function outbounds(profile: Profile, nodes: BuiltNode[]): Json[] {
  const s = profile.settings;
  const grouped = nodes.filter((x) => x.node.inGroups).map((x) => x.node.tag);
  const viaTailnet = s.tailnets.filter((t) => t.asProxy).map((t) => t.tag);
  const tags = memberTags(profile, nodes);
  const groups = profile.groups.filter((g) => tags.has(g.id)).map((g) => groupOutbound(g, tags));
  const proxyDefault = s.proxyDefault !== "auto" && tags.has(s.proxyDefault) ? tags.get(s.proxyDefault)! : "auto";
  return [
    {
      type: "selector",
      tag: "proxy",
      outbounds: ["auto", ...groups.map((g) => g.tag as string), ...(s.listNodesInProxy ? grouped : []), ...viaTailnet],
      default: proxyDefault,
    },
    { type: "urltest", tag: "auto", outbounds: grouped, ...URL_TEST },
    ...groups,
    ...nodes.filter((x) => !x.endpoint).map((x) => x.object),
    { type: "direct", tag: "direct" },
  ];
}

function tunInbound(s: Settings): Json {
  return {
    type: "tun",
    tag: "tun-in",
    address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
    auto_route: true,
    // Linux: nftables-based redirect, recommended by sing-box for routing and performance.
    ...(s.platform === "linux" ? { auto_redirect: true } : {}),
    strict_route: true,
  };
}

export function generateConfig(profile: Profile): Json {
  const s = profile.settings;
  const nodes = profile.nodes.flatMap((node) => {
    const { object, endpoint } = nodeObject(node);
    return object ? [{ node, object, endpoint: !!endpoint }] : [];
  });
  const endpoints = [
    ...s.tailnets.map((t) => tailnetEndpoint(t).endpoint).filter((e): e is Json => !!e),
    ...nodes.filter((x) => x.endpoint).map((x) => x.object),
  ];
  return {
    $schema: "https://sing-box.sagernet.org/schema.json",
    log: { level: "info", timestamp: true },
    dns: {
      servers: dnsServers(s),
      rules: dnsRules(s),
      final: "remote",
      reverse_mapping: true,
    },
    http_clients: [{ tag: "rule-set-download", detour: "proxy" }],
    ...(endpoints.length ? { endpoints } : {}),
    inbounds: [tunInbound(s)],
    outbounds: outbounds(profile, nodes),
    route: {
      rules: routeRules(s),
      rule_set: ruleSets(s),
      final: "proxy",
      auto_detect_interface: true,
      default_http_client: "rule-set-download",
      default_domain_resolver: "local",
    },
    experimental: {
      cache_file: { enabled: true },
      clash_api: {
        ...(s.clashController.trim() ? { external_controller: s.clashController.trim() } : {}),
        ...(s.clashSecret ? { secret: s.clashSecret } : {}),
        default_mode: s.defaultMode,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Validation

export type IssueSection = "nodes" | "groups" | "routing" | "tailscale" | "settings";

export interface Issue {
  level: "error" | "warning";
  /** Full sentence, including which node or tailnet it is about. */
  message: string;
  /** The same without the node/tailnet prefix, for showing inside its card. */
  detail: string;
  section: IssueSection;
  /** Node or tailnet id the issue belongs to. */
  id?: string;
}

/** Any non-empty name (Clash-style names like 「🇭🇰 香港 01」 included) without edge whitespace or control characters. */
const TAG_RE = /^(?!\s)[^\p{Cc}]*\S$/u;

/** Paths of secret-like fields left empty anywhere in a node, e.g. `tls.reality.public_key`. */
function emptySecretPaths(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => emptySecretPaths(x, `${path}[${i}]`));
  if (!v || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) => {
    const p = path ? `${path}.${k}` : k;
    return x === "" && SECRET_FIELDS.includes(k) ? [p] : emptySecretPaths(x, p);
  });
}

/** Shadowsocks 2022 passwords are base64 keys sized to the cipher (sing-box refuses to start otherwise). */
function shadowsocks2022KeyError(o: Json): string | undefined {
  const method = String(o.method ?? "");
  if (o.type !== "shadowsocks" || !method.startsWith("2022-") || typeof o.password !== "string" || !o.password) return;
  const size = method.includes("aes-128") ? 16 : 32;
  for (const key of o.password.split(":")) {
    let bytes = -1;
    try {
      bytes = atob(key).length;
    } catch {
      // not base64
    }
    if (bytes !== size) {
      return `${method} 的密码必须是 ${size} 字节的 base64 密钥（可用 sing-box generate rand --base64 ${size} 生成）`;
    }
  }
}
const RESERVED_TAGS = ["proxy", "auto", "direct", "local", "remote", "tun-in"];

/** Problems that would make sing-box reject the config or leave it without a usable proxy. */
export function validate(profile: Profile): Issue[] {
  const s = profile.settings;
  const issues: Issue[] = [];
  type Where = { section: IssueSection; id?: string; label?: string };
  const add = (level: Issue["level"], where: Where, detail: string) =>
    issues.push({ level, detail, message: where.label ? `${where.label}：${detail}` : detail, section: where.section, id: where.id });
  const err = (where: Where, detail: string) => add("error", where, detail);
  const warn = (where: Where, detail: string) => add("warning", where, detail);
  const NODES: Where = { section: "nodes" };
  const ROUTING: Where = { section: "routing" };
  const SETTINGS: Where = { section: "settings" };
  const tags = new Map<string, number>();
  const addTag = (t: string) => tags.set(t, (tags.get(t) ?? 0) + 1);
  RESERVED_TAGS.forEach(addTag);

  const nodeTags = new Set(profile.nodes.map((n) => n.tag));
  const tailnetTags = new Set(s.tailnets.map((t) => t.tag));
  if (profile.nodes.length === 0) err(NODES, "至少需要一个节点");
  else if (!profile.nodes.some((n) => n.inGroups)) err(NODES, "至少要有一个节点加入代理组");
  for (const n of profile.nodes) {
    const at: Where = { section: "nodes", id: n.id, label: `节点「${n.tag || "(未命名)"}」` };
    if (!TAG_RE.test(n.tag)) err(at, "标签不能为空，首尾不能有空格");
    addTag(n.tag);
    const { object, error } = nodeObject(n);
    if (error) {
      err(at, error);
      continue;
    }
    const o = object!;
    if (NEEDS_SERVER.includes(String(o.type)) && !o.server) err(at, "缺少 server");
    if (typeof o.server === "string" && /(^|\.)example\.com$/.test(o.server)) warn(at, "server 还是模板里的示例地址");
    for (const path of emptySecretPaths(o)) warn(at, `${path} 为空，sing-box 可能无法加载`);
    const ssKeyError = shadowsocks2022KeyError(o);
    if (ssKeyError) err(at, ssKeyError);
    if (typeof o.detour === "string" && !nodeTags.has(o.detour) && !tailnetTags.has(o.detour) && o.detour !== "direct") {
      err(at, `detour 指向的「${o.detour}」不存在`);
    }
  }

  const stateDirs = new Map<string, string>();
  for (const t of s.tailnets) {
    const at: Where = { section: "tailscale", id: t.id, label: `Tailscale「${t.tag || "(未命名)"}」` };
    if (!TAG_RE.test(t.tag)) err(at, "标签不能为空，首尾不能有空格");
    addTag(t.tag);
    if (hasDns(t)) addTag(dnsTag(t));
    const { endpoint, error } = tailnetEndpoint(t);
    if (error) err(at, `端点 JSON 有误：${error}`);
    if (endpoint) {
      const dir = String(endpoint.state_directory ?? "tailscale");
      if (stateDirs.has(dir)) err(at, `state_directory「${dir}」与「${stateDirs.get(dir)}」重复，每个 tailnet 需要独立目录`);
      stateDirs.set(dir, t.tag);
      if (t.asProxy && !endpoint.exit_node) warn(at, "作为代理出口但没有填出口节点，经它的流量只能到达 tailnet 内的地址");
      if ("exit_node" in (parseJsonc(t.endpoint) as Json)) warn(at, "端点 JSON 里的 exit_node 不会生效，请填在「出口节点」里");
    }
    const dns = parseDomainList(t.dnsDomains.join("\n"));
    if (dns.invalid.length) err(at, `分域 DNS 域名格式不正确：${dns.invalid.join("、")}`);
    const routes = parseRuleList(t.routes.join("\n"));
    if (routes.invalid.length) err(at, `额外路由格式不正确：${routes.invalid.join("、")}`);
  }
  const groupIds = new Set(profile.groups.map((g) => g.id));
  const usable = usableGroups(profile.groups, new Set([...profile.nodes.map((n) => n.id), ...s.tailnets.map((t) => t.id)]));
  for (const g of profile.groups) {
    const at: Where = { section: "groups", id: g.id, label: `代理组「${g.tag || "(未命名)"}」` };
    if (!TAG_RE.test(g.tag)) err(at, "名称不能为空，首尾不能有空格");
    addTag(g.tag);
    if (!usable.has(g.id)) {
      warn(at, g.members.some((m) => m !== g.id && groupIds.has(m)) ? "成员里只有空的代理组，暂不写入配置" : "还没有成员，暂不写入配置");
    }
    if (g.type === "urltest") {
      if (g.interval.trim() && !/^\d+(ms|s|m|h)$/.test(g.interval.trim())) err(at, `测速间隔「${g.interval}」格式不对，例如 3m、30s`);
      if (g.tolerance !== null && (!Number.isInteger(g.tolerance) || g.tolerance < 0)) err(at, "容差必须是非负整数（毫秒）");
    }
  }
  // Groups containing each other (directly or through other groups) would never resolve.
  const inCycle = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (path.includes(id)) return path.slice(path.indexOf(id)).forEach((x) => inCycle.add(x));
    const g = profile.groups.find((x) => x.id === id);
    g?.members.filter((m) => groupIds.has(m)).forEach((m) => visit(m, [...path, id]));
  };
  profile.groups.forEach((g) => visit(g.id, []));
  for (const g of profile.groups) {
    if (inCycle.has(g.id)) {
      err({ section: "groups", id: g.id, label: `代理组「${g.tag}」` }, "和其他代理组互相包含，形成了循环");
    }
  }

  for (const [t, n] of tags) {
    if (n < 2) continue;
    // Point at the first node or tailnet using it, so the card shows the problem.
    const node = profile.nodes.find((x) => x.tag === t);
    const tailnet = s.tailnets.find((x) => x.tag === t || dnsTag(x) === t);
    const group = profile.groups.find((x) => x.tag === t);
    const where: Where = node
      ? { section: "nodes", id: node.id }
      : tailnet
        ? { section: "tailscale", id: tailnet.id }
        : group
          ? { section: "groups", id: group.id }
          : NODES;
    err(where, RESERVED_TAGS.includes(t) ? `标签 ${t} 是生成器自己用的，请换一个` : `标签重复：${t}`);
  }

  const subnet = s.clientSubnet.trim();
  if (subnet && !parseCidr(subnet.toLowerCase())) err(SETTINGS, `ECS 网段格式不正确：${subnet}`);
  const direct = parseDomainList(s.directDomains.join("\n"));
  if (direct.invalid.length) err(ROUTING, `直连域名格式不正确：${direct.invalid.join("、")}`);
  const proxy = parseRuleList(s.proxyRules.join("\n"));
  if (proxy.invalid.length) err(ROUTING, `代理域名或 IP 格式不正确：${proxy.invalid.join("、")}`);
  if (s.clashController.trim() && !s.clashSecret) warn(SETTINGS, "Clash API 已开启但没有设置 secret");
  if (s.remoteDns.provider === "custom") {
    const { error } = customDnsServer(s.remoteDns.custom);
    if (error) err(SETTINGS, `自定义代理 DNS 服务器：${error}（暂时改用 Google）`);
  }
  return issues;
}
