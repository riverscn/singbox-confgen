// Import proxies and proxy groups from a Clash (mihomo) config. Each proxy becomes the sing-box
// outbound or endpoint for the same server; the field mappings follow Sub-Store's sing-box
// producer and xmdhs/clash2singbox. Rules, DNS and providers are left out, as with sing-box
// imports: the generator's own policy replaces them.

import { parse } from "yaml";
import { newGroup, newNode } from "./defaults";
import type { ImportResult } from "./importer";
import type { ProxyGroup, ProxyNode } from "./types";

type Json = Record<string, any>;

/** A proxy sing-box can't express; the reason is shown next to its name. */
class Unsupported extends Error {}
const unsupported = (reason: string): never => {
  throw new Unsupported(reason);
};

const pretty = (o: Json) => JSON.stringify(o, null, 2);
const list = (v: unknown): any[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
/** Drops undefined fields so the node JSON only shows what was set. */
const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const int = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
};
/** `a,b` or a list, as a list of trimmed strings. */
const strings = (v: unknown): string[] =>
  list(v)
    .flatMap((x) => String(x).split(","))
    .map((x) => x.trim())
    .filter(Boolean);
/** Seconds (mihomo writes plain numbers) as a duration the editor takes. */
function seconds(v: unknown): string | undefined {
  const n = int(v);
  if (n === undefined || n <= 0) return undefined;
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}
/** Milliseconds as a duration, in whole seconds where it can be. */
function millis(v: unknown): string | undefined {
  const n = int(v);
  if (n === undefined || n <= 0) return undefined;
  return n % 1000 === 0 ? seconds(n / 1000) : `${n}ms`;
}
/** Bandwidth in Mbps; mihomo takes `100`, `"100 Mbps"` or `"1 Gbps"`. */
function mbps(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(?:bps)?\s*$/i.exec(String(v ?? ""));
  if (!m) return undefined;
  const scale: Record<string, number> = { "": 1, K: 0.001, M: 1, G: 1000, T: 1_000_000 };
  return Math.max(1, Math.round(Number(m[1]) * scale[m[2].toUpperCase()]));
}

const UTLS = ["chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized"];
const IP_STRATEGY: Record<string, string> = {
  ipv4: "ipv4_only",
  ipv6: "ipv6_only",
  "ipv4-prefer": "prefer_ipv4",
  "ipv6-prefer": "prefer_ipv6",
};

/** Dial fields every outbound shares. */
function dial(p: Json): Json {
  const strategy = IP_STRATEGY[p["ip-version"]];
  return clean({
    detour: typeof p["dialer-proxy"] === "string" && p["dialer-proxy"] ? p["dialer-proxy"] : undefined,
    tcp_fast_open: p.tfo ? true : undefined,
    tcp_multi_path: p.mptcp ? true : undefined,
    // Node addresses are resolved by the generator's `local` server; keep the address family.
    domain_resolver: strategy ? { server: "local", strategy } : undefined,
  });
}

function server(p: Json): Json {
  if (!p.server) unsupported("缺少 server");
  const port = int(p.port);
  if (port === undefined || port <= 0 || port > 65535) unsupported("端口无效");
  return { server: String(p.server), server_port: port };
}

/** mihomo allows UDP only when asked; sing-box allows it unless told otherwise. */
const udp = (p: Json): Json => (p.udp === false ? { network: "tcp" } : {});

/** ECH configs are base64 in mihomo and PEM in sing-box. */
function ech(o: Json): Json | undefined {
  if (!o || typeof o !== "object" || !o.enable) return undefined;
  const config = strings(o.config);
  return clean({
    enabled: true,
    config: config.length
      ? config[0].startsWith("-----") ? config : ["-----BEGIN ECH CONFIGS-----", ...config, "-----END ECH CONFIGS-----"]
      : undefined,
    query_server_name: o["query-server-name"] || undefined,
  });
}

function tls(p: Json, on: boolean, ignored: Set<string>): Json | undefined {
  if (!on) return undefined;
  const reality = p["reality-opts"];
  const fingerprint = String(p["client-fingerprint"] ?? "").toLowerCase();
  const utls = UTLS.includes(fingerprint) ? { enabled: true, fingerprint } : reality ? { enabled: true } : undefined;
  // A certificate fingerprint pins the whole certificate; sing-box only pins public keys.
  if (p.fingerprint) ignored.add("fingerprint");
  const alpn = strings(p.alpn);
  return clean({
    enabled: true,
    server_name: p.servername || p.sni || undefined,
    insecure: p["skip-cert-verify"] ? true : undefined,
    alpn: alpn.length ? alpn : undefined,
    certificate: p["ca-str"] ? [String(p["ca-str"])] : undefined,
    certificate_path: p.ca ? String(p.ca) : undefined,
    utls,
    reality: reality
      ? clean({ enabled: true, public_key: reality["public-key"], short_id: reality["short-id"] || undefined })
      : undefined,
    ech: ech(p["ech-opts"]),
  });
}

/** Headers as sing-box takes them: a single value as a string, several as a list. */
function headers(h: unknown, skip: string[] = []): Json | undefined {
  if (!h || typeof h !== "object") return undefined;
  const out = Object.fromEntries(
    Object.entries(h as Json)
      .filter(([k, v]) => !skip.includes(k.toLowerCase()) && v !== "" && v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? (v.length === 1 ? String(v[0]) : v.map(String)) : String(v)]),
  );
  return Object.keys(out).length ? out : undefined;
}
const hostHeader = (h: unknown): string[] =>
  strings(Object.entries((h ?? {}) as Json).find(([k]) => k.toLowerCase() === "host")?.[1]);

/** The V2Ray transport for vmess, vless and trojan. */
function transport(p: Json): Json | undefined {
  const network = p.network ?? "tcp";
  switch (network) {
    case "tcp":
      return undefined;
    case "ws": {
      const o = p["ws-opts"] ?? {};
      let path = o.path ? String(o.path) : undefined;
      let earlyData = int(o["max-early-data"]);
      let earlyHeader = o["early-data-header-name"] || undefined;
      // `?ed=2048` in the path is Xray's way of asking for early data.
      const ed = path ? /[?&]ed=(\d+)/.exec(path) : null;
      if (path && ed) {
        earlyData = Number(ed[1]);
        earlyHeader = "Sec-WebSocket-Protocol";
        path = path.replace(/([?&])ed=\d+&?/, "$1").replace(/[?&]$/, "");
      }
      if (o["v2ray-http-upgrade"]) {
        return clean({ type: "httpupgrade", path, host: hostHeader(o.headers)[0], headers: headers(o.headers, ["host"]) });
      }
      return clean({ type: "ws", path, headers: headers(o.headers), max_early_data: earlyData, early_data_header_name: earlyHeader });
    }
    case "http": {
      const o = p["http-opts"] ?? {};
      const host = hostHeader(o.headers);
      return clean({
        type: "http",
        method: o.method || undefined,
        path: list(o.path)[0] ? String(list(o.path)[0]) : undefined,
        host: host.length ? host : undefined,
        headers: headers(o.headers, ["host"]),
      });
    }
    case "h2": {
      const o = p["h2-opts"] ?? {};
      const host = strings(o.host);
      return clean({ type: "http", path: o.path ? String(o.path) : undefined, host: host.length ? host : undefined });
    }
    case "grpc": {
      const name = p["grpc-opts"]?.["grpc-service-name"];
      return clean({ type: "grpc", service_name: name ? String(name) : undefined });
    }
    default:
      return unsupported(`sing-box 不支持 ${network} 传输`);
  }
}

function multiplex(smux: Json | undefined): Json | undefined {
  if (!smux?.enabled) return undefined;
  const brutal = smux["brutal-opts"];
  return clean({
    enabled: true,
    protocol: smux.protocol || undefined,
    max_connections: int(smux["max-connections"]),
    min_streams: int(smux["min-streams"]),
    max_streams: int(smux["max-streams"]),
    padding: smux.padding ? true : undefined,
    brutal: brutal?.enabled ? clean({ enabled: true, up_mbps: mbps(brutal.up), down_mbps: mbps(brutal.down) }) : undefined,
  });
}

/** mihomo's `443,8000-9000` as sing-box's `["443:443", "8000:9000"]`. */
function ports(v: unknown): string[] | undefined {
  const out = strings(v).map((r) => {
    const [a, b = a] = r.split("-").map((x) => x.trim());
    return `${a}:${b}`;
  });
  return out.length ? out : undefined;
}

function udpOverTcp(p: Json): Json | undefined {
  if (!p["udp-over-tcp"]) return undefined;
  return { enabled: true, version: int(p["udp-over-tcp-version"]) ?? 1 };
}

/** A converted proxy: its node, and helper nodes it detours through (ShadowTLS). */
interface Converted {
  body: Json;
  helpers: { tag: string; body: Json }[];
}

function shadowsocks(p: Json, ignored: Set<string>): Converted {
  const body: Json = {
    type: "shadowsocks",
    ...server(p),
    method: p.cipher,
    password: p.password,
    ...udp(p),
    udp_over_tcp: udpOverTcp(p),
    multiplex: multiplex(p.smux),
    ...dial(p),
  };
  const opts: Json = p["plugin-opts"] ?? {};
  switch (p.plugin ?? "") {
    case "":
      return { body: clean(body), helpers: [] };
    case "obfs":
      body.plugin = "obfs-local";
      body.plugin_opts = [`obfs=${opts.mode ?? "http"}`, opts.host ? `obfs-host=${opts.host}` : ""].filter(Boolean).join(";");
      return { body: clean(body), helpers: [] };
    case "v2ray-plugin":
      if (opts.mode && opts.mode !== "websocket") unsupported(`v2ray-plugin 的 ${opts.mode} 模式`);
      body.plugin = "v2ray-plugin";
      body.plugin_opts = [opts.tls ? "tls" : "", opts.host ? `host=${opts.host}` : "", opts.path ? `path=${opts.path}` : ""]
        .filter(Boolean)
        .join(";");
      if (opts.mux) ignored.add("plugin-opts.mux");
      return { body: clean(body), helpers: [] };
    case "shadow-tls": {
      // ShadowTLS is a separate outbound in sing-box: it dials the server and Shadowsocks runs over it.
      const tag = `${p.name}-shadowtls`;
      const fingerprint = String(p["client-fingerprint"] ?? "").toLowerCase();
      const helper = clean({
        type: "shadowtls",
        ...server(p),
        version: int(opts.version) ?? 2,
        password: opts.version === 1 ? undefined : opts.password,
        tls: clean({
          enabled: true,
          server_name: opts.host || undefined,
          insecure: p["skip-cert-verify"] ? true : undefined,
          alpn: strings(opts.alpn).length ? strings(opts.alpn) : undefined,
          utls: UTLS.includes(fingerprint) ? { enabled: true, fingerprint } : undefined,
        }),
        ...dial(p),
      });
      // The server stays (the editor expects one; ShadowTLS dials its own), the dial options move.
      const { detour: _d, tcp_fast_open: _t, tcp_multi_path: _m, domain_resolver: _r, ...ss } = body;
      return { body: clean({ ...ss, detour: tag }), helpers: [{ tag, body: helper }] };
    }
    default:
      return unsupported(`sing-box 不支持 ${p.plugin} 插件`);
  }
}

function convertProxy(p: Json, ignored: Set<string>): Converted {
  const single = (body: Json): Converted => ({ body: clean(body), helpers: [] });
  switch (p.type) {
    case "ss":
      return shadowsocks(p, ignored);
    case "vmess":
      return single({
        type: "vmess",
        ...server(p),
        uuid: p.uuid,
        security: p.cipher && p.cipher !== "auto" ? p.cipher : undefined,
        alter_id: int(p.alterId) || undefined,
        global_padding: p["global-padding"] ? true : undefined,
        authenticated_length: p["authenticated-length"] ? true : undefined,
        packet_encoding: p["packet-encoding"] || (p.xudp ? "xudp" : undefined),
        ...udp(p),
        tls: tls(p, !!p.tls || p.network === "h2", ignored),
        transport: transport(p),
        multiplex: multiplex(p.smux),
        ...dial(p),
      });
    case "vless":
      if (p.encryption && p.encryption !== "none") unsupported("VLESS encryption");
      return single({
        type: "vless",
        ...server(p),
        uuid: p.uuid,
        flow: p.flow || undefined,
        packet_encoding: p["packet-encoding"] || (p.xudp ? "xudp" : undefined),
        ...udp(p),
        tls: tls(p, !!p.tls || !!p["reality-opts"] || p.network === "h2", ignored),
        transport: transport(p),
        multiplex: multiplex(p.smux),
        ...dial(p),
      });
    case "trojan":
      if (p["ss-opts"]?.enabled) unsupported("trojan-go 的 ss-opts");
      return single({
        type: "trojan",
        ...server(p),
        password: p.password,
        ...udp(p),
        tls: tls(p, true, ignored),
        transport: transport(p),
        multiplex: multiplex(p.smux),
        ...dial(p),
      });
    case "hysteria":
      if (p.protocol && p.protocol !== "udp") unsupported(`Hysteria 的 ${p.protocol} 协议`);
      return single({
        type: "hysteria",
        ...server(p),
        server_ports: ports(p.ports),
        hop_interval: seconds(p["hop-interval"]),
        auth_str: p["auth-str"] ?? p.auth_str,
        up_mbps: mbps(p.up),
        down_mbps: mbps(p.down),
        obfs: p.obfs || undefined,
        connection_receive_window: int(p["recv-window-conn"]),
        stream_receive_window: int(p["recv-window"]),
        disable_path_mtu_discovery: p["disable-mtu-discovery"] ? true : undefined,
        tls: tls(p, true, ignored),
        ...dial(p),
      });
    case "hysteria2":
      return single({
        type: "hysteria2",
        ...server(p),
        server_ports: ports(p.ports),
        hop_interval: seconds(p["hop-interval"]),
        up_mbps: mbps(p.up),
        down_mbps: mbps(p.down),
        password: p.password,
        obfs: p.obfs ? clean({ type: p.obfs, password: p["obfs-password"] }) : undefined,
        tls: tls(p, true, ignored),
        ...dial(p),
      });
    case "tuic": {
      if (p.token && !p.uuid) unsupported("TUIC v4");
      return single({
        type: "tuic",
        ...server(p),
        uuid: p.uuid,
        password: p.password,
        congestion_control: p["congestion-controller"] || undefined,
        udp_relay_mode: p["udp-relay-mode"] || undefined,
        udp_over_stream: p["udp-over-stream"] ? true : undefined,
        zero_rtt_handshake: p["reduce-rtt"] ? true : undefined,
        heartbeat: millis(p["heartbeat-interval"]),
        // mihomo offers h3 when no ALPN is set; TUIC servers expect it.
        tls: tls({ alpn: "h3", ...p }, true, ignored),
        ...dial(p),
      });
    }
    case "anytls":
      return single({
        type: "anytls",
        ...server(p),
        password: p.password,
        idle_session_check_interval: seconds(p["idle-session-check-interval"]),
        idle_session_timeout: seconds(p["idle-session-timeout"]),
        min_idle_session: int(p["min-idle-session"]),
        tls: tls(p, true, ignored),
        ...dial(p),
      });
    case "snell":
      if (p["obfs-opts"]?.mode === "shadow-tls") unsupported("Snell over ShadowTLS");
      return single({
        type: "snell",
        ...server(p),
        psk: p.psk,
        version: int(p.version),
        obfs_mode: p["obfs-opts"]?.mode || undefined,
        obfs_host: p["obfs-opts"]?.host || undefined,
        ...udp(p),
        ...dial(p),
      });
    case "socks5":
      if (p.tls) unsupported("SOCKS5 over TLS");
      return single({
        type: "socks",
        ...server(p),
        version: "5",
        username: p.username || undefined,
        password: p.password || undefined,
        ...udp(p),
        ...dial(p),
      });
    case "http":
      return single({
        type: "http",
        ...server(p),
        username: p.username || undefined,
        password: p.password || undefined,
        headers: headers(p.headers),
        tls: tls(p, !!p.tls, ignored),
        ...dial(p),
      });
    case "ssh": {
      const key = p["private-key"] ? String(p["private-key"]) : undefined;
      return single({
        type: "ssh",
        ...server(p),
        user: p.username || undefined,
        password: p.password || undefined,
        // mihomo takes either the key itself or a path, telling them apart the same way.
        ...(key ? (key.includes("PRIVATE KEY") ? { private_key: key } : { private_key_path: key }) : {}),
        private_key_passphrase: p["private-key-passphrase"] || undefined,
        host_key: list(p["host-key"]).length ? list(p["host-key"]).map(String) : undefined,
        host_key_algorithms: list(p["host-key-algorithms"]).length ? list(p["host-key-algorithms"]).map(String) : undefined,
        ...dial(p),
      });
    }
    case "wireguard":
      return single(wireguard(p));
    case "ssr":
      return unsupported("sing-box 已不支持 ShadowsocksR");
    default:
      return unsupported(`sing-box 不支持 ${p.type} 类型`);
  }
}

/** mihomo's `reserved` is a list of three bytes or their base64. */
function reserved(v: unknown): number[] | undefined {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string" && v) {
    try {
      return [...atob(v)].map((c) => c.charCodeAt(0));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const ALL_IPS = ["0.0.0.0/0", "::/0"];

/** A WireGuard proxy as the endpoint sing-box uses since 1.11. */
function wireguard(p: Json): Json {
  if (p["amnezia-wg-option"]) unsupported("AmneziaWG");
  const cidr = (ip: unknown, bits: number) => (ip ? (String(ip).includes("/") ? String(ip) : `${ip}/${bits}`) : undefined);
  const address = [cidr(p.ip, 32), cidr(p.ipv6, 128)].filter(Boolean);
  const peer = (x: Json, fallback: Json = {}) =>
    clean({
      address: x.server ?? fallback.server,
      port: int(x.port ?? fallback.port),
      public_key: x["public-key"] ?? fallback["public-key"],
      pre_shared_key: x["pre-shared-key"] ?? fallback["pre-shared-key"],
      allowed_ips: list(x["allowed-ips"]).length ? list(x["allowed-ips"]) : ALL_IPS,
      persistent_keepalive_interval: int(x["persistent-keepalive"] ?? fallback["persistent-keepalive"]),
      reserved: reserved(x.reserved ?? fallback.reserved),
    });
  const peers = list(p.peers).length ? list(p.peers).map((x) => peer(x, p)) : [peer(p)];
  if (peers.some((x) => !x.address || !x.port)) unsupported("缺少 server");
  const { tcp_fast_open: _t, tcp_multi_path: _m, ...rest } = dial(p);
  return clean({
    type: "wireguard",
    address,
    private_key: p["private-key"],
    mtu: int(p.mtu),
    peers,
    ...rest,
  });
}

/** Built-in policies Clash groups may list; sing-box groups take only outbounds. */
const BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"];
const GROUP_TYPES: Record<string, ProxyGroup["type"] | undefined> = {
  select: "selector",
  "url-test": "urltest",
  fallback: "urltest",
  "load-balance": "urltest",
};

/**
 * A Go regular expression as a JavaScript one. mihomo users write `(?i)` for case-insensitive
 * matching, which JavaScript only takes as a flag; several patterns are separated by backticks.
 */
function goRegexps(v: unknown): RegExp[] {
  return String(v ?? "")
    .split("`")
    .filter(Boolean)
    .map((src) => {
      const i = /^\(\?i\)/.test(src);
      return new RegExp(i ? src.slice(4) : src, i ? "i" : "");
    });
}

const shortList = (items: string[]) => (items.length > 10 ? `${items.slice(0, 10).join("、")} 等 ${items.length} 个` : items.join("、"));

export function isClashConfig(o: unknown): o is Json {
  return !!o && typeof o === "object" && !Array.isArray(o) && ("proxies" in o || "proxy-groups" in o);
}

export function importClashConfig(input: string | Json): ImportResult {
  let config: unknown = input;
  if (typeof input === "string") {
    try {
      // Clash configs often share settings between proxies with anchors and `<<` merge keys.
      config = parse(input, { merge: true, maxAliasCount: -1 });
    } catch (e) {
      throw new Error(`不是有效的 YAML：${(e as Error).message}`);
    }
  }
  if (!isClashConfig(config)) throw new Error("没有找到 proxies 或 proxy-groups，这不像是 Clash 配置");

  const notes: string[] = [];
  const proxies: Json[] = list(config.proxies).filter((p) => p && typeof p === "object" && p.name !== undefined);
  const clashGroups: Json[] = list(config["proxy-groups"]).filter((g) => g && typeof g === "object" && g.name !== undefined);
  const groupNames = new Set(clashGroups.map((g) => String(g.name)));

  // ---- nodes ----
  const nodes: ProxyNode[] = [];
  /** Clash name → node, for group members and detours. */
  const byName = new Map<string, ProxyNode>();
  const helpers = new Set<string>();
  const skipped: string[] = [];
  const ignored = new Map<string, Set<string>>();
  for (const p of proxies) {
    const name = String(p.name);
    if (["direct", "dns", "reject"].includes(p.type)) continue;
    const fields = new Set<string>();
    try {
      const { body, helpers: extra } = convertProxy(p, fields);
      const node = newNode({ tag: name, body: pretty(body) });
      nodes.push(node);
      byName.set(name, node);
      for (const h of extra) {
        nodes.push(newNode({ tag: h.tag, body: pretty(h.body), inGroups: false }));
        helpers.add(h.tag);
      }
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      skipped.push(`${name}（${e.message}）`);
    }
    for (const f of fields) ignored.set(f, (ignored.get(f) ?? new Set()).add(name));
  }
  if (skipped.length) notes.push(`不支持、已跳过：${shortList(skipped)}`);
  if (ignored.has("fingerprint")) {
    notes.push(`sing-box 不能按证书指纹（fingerprint）校验，已忽略：${shortList([...ignored.get("fingerprint")!])}`);
  }
  if (ignored.has("plugin-opts.mux")) notes.push(`v2ray-plugin 的 mux 已忽略：${shortList([...ignored.get("plugin-opts.mux")!])}`);

  const providers = Object.keys(config["proxy-providers"] ?? {});
  if (providers.length) notes.push(`proxy-providers（${providers.join("、")}）需要联网拉取，没有导入；代理组里只保留直接列出的节点`);

  // ---- relay groups: chains of nodes ----
  // client → a → b → c becomes c with detour b, b with detour a. The hops after the first are
  // copies, since their detour changes; the last one takes the group's name so other groups
  // can still list it.
  const relays = clashGroups.filter((g) => g.type === "relay");
  for (const g of relays) {
    const name = String(g.name);
    const hops = list(g.proxies)
      .map(String)
      .filter((h) => h !== "DIRECT");
    const nodesOf = hops.map((h) => byName.get(h));
    if (!hops.length || nodesOf.some((n) => !n) || nodesOf.slice(1).some((n) => helpers.has(`${n!.tag}-shadowtls`))) {
      notes.push(`relay 组「${name}」里有代理组、不支持的节点或 ShadowTLS 节点，无法转换为链式节点，已跳过`);
      continue;
    }
    if (hops.length === 1) {
      byName.set(name, nodesOf[0]!);
      continue;
    }
    let prev = nodesOf[0]!.tag;
    nodesOf.slice(1).forEach((n, i) => {
      const last = i === hops.length - 2;
      const tag = last ? name : `${name}-hop${i + 2}`;
      const body = { ...JSON.parse(n!.body), detour: prev };
      const copy = newNode({ tag, body: pretty(body), inGroups: false });
      nodes.push(copy);
      if (last) byName.set(name, copy);
      prev = tag;
    });
    notes.push(`relay 组「${name}」已转换为链式节点：${hops.join(" → ")}`);
  }

  // dialer-proxy may name a node (or a relay); the editor checks detours against nodes only.
  const nodeTags = new Set(nodes.map((n) => n.tag));
  const badDetours: string[] = [];
  for (const n of nodes) {
    const body = JSON.parse(n.body);
    if (typeof body.detour !== "string") continue;
    const target = nodeTags.has(body.detour) ? body.detour : byName.get(body.detour)?.tag;
    if (target && nodeTags.has(target) && target !== n.tag) {
      if (target !== body.detour) n.body = pretty({ ...body, detour: target });
      continue;
    }
    const { detour: _d, ...rest } = body;
    n.body = pretty(rest);
    badDetours.push(`${n.tag} → ${body.detour}`);
  }
  if (badDetours.length) notes.push(`dialer-proxy 只能指向节点，以下已去掉（节点会直接连接）：${shortList(badDetours)}`);

  if (!nodes.length) throw new Error("配置里没有可导入的节点");

  // ---- groups ----
  const kept = clashGroups.filter((g) => GROUP_TYPES[g.type]);
  const other = clashGroups.filter((g) => !GROUP_TYPES[g.type] && g.type !== "relay").map((g) => `${g.name}（${g.type}）`);
  if (other.length) notes.push(`不支持的代理组类型，已跳过：${other.join("、")}`);
  const groups = kept.map((g) =>
    newGroup({
      tag: String(g.name),
      type: GROUP_TYPES[g.type],
      testUrl: g.url && g.url !== "https://www.gstatic.com/generate_204" ? String(g.url) : "",
      // sing-box's default, as the editor leaves it.
      interval: seconds(g.interval) === "3m" ? "" : (seconds(g.interval) ?? ""),
      tolerance: g.type === "url-test" && int(g.tolerance) !== undefined && int(g.tolerance) !== 50 ? int(g.tolerance)! : null,
    }),
  );
  const groupId = new Map(groups.map((g) => [g.tag, g.id]));
  const builtins = new Set<string>();
  const missing = new Set<string>();
  const usedProviders = new Set<string>();
  const badFilters: string[] = [];
  const mainNames = proxies.map((p) => String(p.name)).filter((n) => byName.has(n));
  kept.forEach((src, i) => {
    const names = list(src.proxies).map(String);
    list(src.use).forEach((u) => usedProviders.add(String(u)));
    // include-all also takes the providers' proxies, which aren't imported.
    if (src["include-all"] || src["include-all-proxies"]) {
      let all = mainNames;
      try {
        const keep = goRegexps(src.filter);
        const drop = goRegexps(src["exclude-filter"]);
        const types = String(src["exclude-type"] ?? "")
          .toLowerCase()
          .split("|")
          .filter(Boolean);
        const typeOf = new Map(proxies.map((p) => [String(p.name), String(p.type).toLowerCase()]));
        all = all.filter(
          (n) =>
            (!keep.length || keep.some((r) => r.test(n))) && !drop.some((r) => r.test(n)) && !types.includes(typeOf.get(n) ?? ""),
        );
      } catch {
        badFilters.push(String(src.name));
      }
      names.push(...all);
    }
    const members: string[] = [];
    for (const n of names) {
      const id = byName.get(n)?.id ?? groupId.get(n);
      if (id) {
        if (!members.includes(id)) members.push(id);
      } else if (BUILTIN.includes(n)) builtins.add(n);
      else missing.add(n);
    }
    groups[i].members = members;
  });
  if (badFilters.length) notes.push(`代理组 ${badFilters.join("、")} 的 filter 不是有效的正则表达式，已改为包含全部节点`);
  if (builtins.size) notes.push(`sing-box 的代理组不能包含 ${[...builtins].join("、")}，已从组中去掉`);
  if (missing.size) notes.push(`代理组里引用的 ${shortList([...missing])} 没有导入，已从组中去掉`);
  if (usedProviders.size && !providers.length) notes.push(`代理组用到的 proxy-providers（${[...usedProviders].join("、")}）没有导入`);
  const approximated = kept.filter((g) => g.type === "fallback" || g.type === "load-balance").map((g) => g.name);
  if (approximated.length) {
    notes.push(`sing-box 没有 fallback / load-balance，${approximated.map((n) => `「${n}」`).join("")}已改为自动测速（urltest）`);
  }

  // Groups left empty go, and so do references to them, which may empty others in turn.
  let result = groups;
  for (;;) {
    const empty = new Set(result.filter((g) => !g.members.length).map((g) => g.id));
    if (!empty.size) break;
    for (const g of result.filter((g) => empty.has(g.id))) notes.push(`代理组「${g.tag}」没有可导入的成员，已跳过`);
    result = result.filter((g) => !empty.has(g.id)).map((g) => ({ ...g, members: g.members.filter((m) => !empty.has(m)) }));
  }

  // Offer the nodes the groups offered; without groups (or none naming a node), every node.
  const listed = new Set(result.flatMap((g) => g.members));
  const offered = nodes.filter((n) => listed.has(n.id));
  for (const n of nodes) n.inGroups = offered.length ? listed.has(n.id) : !helpers.has(n.tag) && n.inGroups;

  return { nodes, tailnets: [], groups: result, notes };
}
