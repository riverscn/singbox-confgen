// Import nodes and Tailscale tailnets from an existing sing-box config (any version close to
// 1.14, including SFM's re-saved form). Everything else in it (DNS, routing) is left out: the
// generator's own policy replaces it.

import { parseJsonc } from "./generate";
import { newGroup, newNode, newTailnet } from "./defaults";
import { ENDPOINT_TYPES, NODE_TYPES } from "./templates";
import type { ProxyGroup, ProxyNode, Tailnet } from "./types";

type Json = Record<string, any>;

export interface ImportResult {
  nodes: ProxyNode[];
  tailnets: Tailnet[];
  groups: ProxyGroup[];
  /** Things the user should know were left out or changed. */
  notes: string[];
}

/** SFM writes single-item lists as plain values. */
const list = (v: unknown): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const pretty = (o: Json) => JSON.stringify(o, null, 2);

/** A rule's domain matchers as list lines, with the prefixes the list editors take. */
const domainLines = (r: Json): string[] => [
  ...list(r.domain).map((d) => `domain:${d}`),
  ...list(r.domain_suffix),
  ...list(r.domain_keyword).map((d) => `domain_keyword:${d}`),
  ...list(r.domain_regex).map((d) => `domain_regex:${d}`),
];

const GROUP_TYPES = ["selector", "urltest"];
/** Group tags the generator creates itself; not imported as user groups. */
const RESERVED_GROUPS = ["proxy", "auto"];

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, "µs": 0.001, ns: 0.000001 };

/**
 * A duration in the single-unit form the editor takes (`3m`, `90s`). SFM re-saves durations the
 * way Go prints them (`3m0s`, `1h30m0s`); anything that is not a whole number of milliseconds is
 * kept as written.
 */
function shortDuration(v: unknown): string {
  if (typeof v !== "string") return "";
  const parts = [...v.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== v) return v;
  const ms = parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit], 0);
  if (!Number.isInteger(ms)) return v;
  for (const unit of ["h", "m", "s"]) if (ms % UNIT_MS[unit] === 0) return `${ms / UNIT_MS[unit]}${unit}`;
  return `${ms}ms`;
}

/** Every peer is routed everything, as the legacy outbound did with its single peer. */
const ALL_IPS = ["0.0.0.0/0", "::/0"];

/** A WireGuard outbound from before sing-box 1.11 rewritten as the endpoint that replaced it. */
function wireguardEndpoint(o: Json): Json {
  const {
    server,
    server_port,
    local_address,
    peer_public_key,
    pre_shared_key,
    reserved,
    peers,
    system_interface,
    interface_name,
    gso: _gso,
    network: _network,
    ...rest
  } = o;
  const peer = (p: Json): Json =>
    Object.fromEntries(
      Object.entries({
        address: p.server,
        port: p.server_port,
        public_key: p.public_key,
        pre_shared_key: p.pre_shared_key,
        allowed_ips: p.allowed_ips ?? ALL_IPS,
        reserved: p.reserved,
      }).filter(([, v]) => v !== undefined),
    );
  return {
    ...rest,
    ...(system_interface ? { system: true } : {}),
    ...(interface_name ? { name: interface_name } : {}),
    ...(local_address !== undefined ? { address: local_address } : {}),
    peers: list(peers).length
      ? list(peers).map(peer)
      : [peer({ server, server_port, public_key: peer_public_key, pre_shared_key, reserved })],
  };
}

/** Fields the generator fills in or that only make sense in the source config. */
function nodeBody(o: Json, keptResolvers: Set<string>): Json {
  const { tag: _tag, ...body } = o;
  if (typeof body.domain_resolver === "string" && !keptResolvers.has(body.domain_resolver)) delete body.domain_resolver;
  if (typeof body.domain_resolver === "object" && body.domain_resolver && !keptResolvers.has(body.domain_resolver.server)) {
    delete body.domain_resolver;
  }
  // SFM writes server_port 0 next to server_ports.
  if (body.server_port === 0 && body.server_ports) delete body.server_port;
  return body;
}

export function importSingBoxConfig(text: string): ImportResult {
  let config: Json;
  try {
    config = parseJsonc(text) as Json;
  } catch (e) {
    throw new Error(`不是有效的 JSON：${(e as Error).message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("不是 sing-box 配置：顶层必须是对象");
  const outbounds: Json[] = list(config.outbounds);
  const endpoints: Json[] = list(config.endpoints);
  if (!outbounds.length && !endpoints.length) throw new Error("没有找到 outbounds 或 endpoints，这不像是 sing-box 配置");

  const notes: string[] = [];
  const dnsServers: Json[] = list(config.dns?.servers);
  const dnsRules: Json[] = list(config.dns?.rules);
  const routeRules: Json[] = list(config.route?.rules);
  const groups = outbounds.filter((o) => GROUP_TYPES.includes(o.type));
  // The generator's own entry groups; when present they say which nodes are offered directly.
  const entry = groups.filter((g) => RESERVED_GROUPS.includes(g.tag));
  const grouped = new Set((entry.length ? entry : groups).flatMap((g) => list(g.outbounds)));

  // ---- Tailscale ----
  const tailnets: Tailnet[] = endpoints
    .filter((e) => e.type === "tailscale")
    .map((e) => {
      // The exit node is edited in its own field; the rest of the endpoint stays as JSON.
      const { type: _type, tag, exit_node, ...body } = e;
      const server = dnsServers.find((s) => s.type === "tailscale" && s.endpoint === tag);
      const dnsTag = server?.tag;
      const magicDns = !!dnsTag && dnsRules.some((r) => list(r.preferred_by).includes(dnsTag));
      const dnsDomains = dnsTag
        ? dnsRules.filter((r) => r.server === dnsTag && !r.preferred_by).flatMap(domainLines)
        : [];
      const routes = routeRules
        .filter((r) => r.outbound === tag && !r.preferred_by && (domainLines(r).length || r.ip_cidr))
        .flatMap((r) => [...domainLines(r), ...list(r.ip_cidr)]);
      return newTailnet({
        tag,
        endpoint: pretty(body),
        magicDns,
        acceptDefaultResolvers: !!server?.accept_default_resolvers,
        dnsDomains,
        routes,
        asProxy: grouped.has(tag) || typeof exit_node === "string",
        exitNode: typeof exit_node === "string" ? exit_node : "",
      });
    });
  const tailnetDns = new Set(dnsServers.filter((s) => s.type === "tailscale").map((s) => s.tag));

  // ---- nodes ----
  // Resolvers that still exist after import: the generator's own servers.
  const keptResolvers = new Set(["local", "remote", ...tailnets.map((t) => `${t.tag}-dns`)]);
  // WireGuard was an outbound before 1.11; the other endpoint types never were.
  const legacyWireguard = outbounds.filter((o) => o.type === "wireguard").map((o) => o.tag);
  const candidates = [
    ...outbounds
      .filter((o) => NODE_TYPES.includes(o.type) && (!ENDPOINT_TYPES.includes(o.type) || o.type === "wireguard"))
      .map((o) => (o.type === "wireguard" ? wireguardEndpoint(o) : o)),
    ...endpoints.filter((e) => ENDPOINT_TYPES.includes(e.type)),
  ];
  if (legacyWireguard.length) {
    notes.push(`旧版 WireGuard outbound（${legacyWireguard.join("、")}）已转换为 endpoint 写法，请核对 peers`);
  }
  const dropped = new Set<string>();
  const nodes = candidates.map((o) => {
    const resolver = typeof o.domain_resolver === "string" ? o.domain_resolver : o.domain_resolver?.server;
    if (resolver && !keptResolvers.has(resolver) && !tailnetDns.has(resolver)) dropped.add(resolver);
    return newNode({
      tag: o.tag,
      body: pretty(nodeBody(o, keptResolvers)),
      // Without groups in the source, offer every node; otherwise keep helper nodes (e.g. a
      // ShadowTLS detour) out of the groups as they were.
      inGroups: groups.length === 0 || grouped.has(o.tag),
    });
  });
  if (dropped.size) notes.push(`节点里的 domain_resolver（${[...dropped].join("、")}）已去掉，改用本地 DNS 解析节点地址`);

  const skipped = outbounds
    .filter((o) => !NODE_TYPES.includes(o.type) && !GROUP_TYPES.includes(o.type) && !["direct", "block", "dns"].includes(o.type))
    .map((o) => `${o.tag}（${o.type}）`);
  if (skipped.length) notes.push(`不支持作为节点、已跳过：${skipped.join("、")}`);
  if (!nodes.length && !tailnets.length) throw new Error("配置里没有可导入的节点或 Tailscale 端点");

  // ---- groups ----
  const userGroups = groups.filter((g) => !RESERVED_GROUPS.includes(g.tag));
  const imported = userGroups.map((g) => newGroup({ tag: g.tag, type: g.type }));
  const idOf = new Map<string, string>([
    ...nodes.map((n) => [n.tag, n.id] as const),
    ...tailnets.map((t) => [t.tag, t.id] as const),
    ...imported.map((g) => [g.tag, g.id] as const),
  ]);
  const droppedMembers = new Set<string>();
  const kept: ProxyGroup[] = [];
  userGroups.forEach((src, i) => {
    const g = imported[i];
    for (const tag of list(src.outbounds)) {
      if (idOf.has(tag)) g.members.push(idOf.get(tag)!);
      else droppedMembers.add(tag);
    }
    if (src.type === "selector" && typeof src.default === "string" && idOf.has(src.default)) g.defaultMember = idOf.get(src.default)!;
    if (src.type === "urltest") {
      g.testUrl = src.url && src.url !== "https://www.gstatic.com/generate_204" ? src.url : "";
      const interval = shortDuration(src.interval);
      g.interval = interval !== "3m" ? interval : "";
      g.tolerance = typeof src.tolerance === "number" && src.tolerance !== 50 ? src.tolerance : null;
    }
    if (g.members.length) kept.push(g);
    else notes.push(`代理组「${g.tag}」没有可导入的成员，已跳过`);
  });
  if (droppedMembers.size) notes.push(`代理组里引用的 ${[...droppedMembers].join("、")} 不是可导入的节点，已从组中去掉`);
  return { nodes, tailnets, groups: kept, notes };
}

/** Outbound tags the generator always emits. */
const RESERVED_TAGS = [...RESERVED_GROUPS, "direct"];

export interface FittedImport {
  nodes: ProxyNode[];
  tailnets: Tailnet[];
  groups: ProxyGroup[];
  /** `old → new` for each renamed tag. */
  renamed: string[];
}

/**
 * Fit an import into a profile of its own. Nodes, tailnets and groups share one namespace with
 * the outbounds the generator adds, so a tag clashing with those or with an earlier incoming tag
 * is renamed (`auto` → `auto-2`), and detours to a renamed node follow it.
 */
export function fitImport(result: ImportResult): FittedImport {
  const used = new Set(RESERVED_TAGS);
  const renames = new Map<string, string>();
  const fit = <T extends { tag: string }>(items: T[]): T[] =>
    items.map((x) => {
      let tag = x.tag;
      for (let i = 2; used.has(tag); i++) tag = `${x.tag}-${i}`;
      used.add(tag);
      if (tag === x.tag) return x;
      if (!renames.has(x.tag)) renames.set(x.tag, tag);
      return { ...x, tag };
    });
  const nodes = fit(result.nodes);
  const tailnets = fit(result.tailnets);
  const groups = fit(result.groups);
  // Bodies come from the importer as plain JSON, so they can be parsed and rewritten as is.
  const follow = (json: string) => {
    const o = JSON.parse(json);
    return typeof o.detour === "string" && renames.has(o.detour) ? pretty({ ...o, detour: renames.get(o.detour) }) : json;
  };
  return {
    nodes: nodes.map((n) => ({ ...n, body: follow(n.body) })),
    tailnets: tailnets.map((t) => ({ ...t, endpoint: follow(t.endpoint) })),
    groups,
    renamed: [...renames].map(([from, to]) => `${from} → ${to}`),
  };
}
