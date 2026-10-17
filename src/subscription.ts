// Subscription content: what a subscription URL returns when fetched by hand (the page itself
// makes no network requests). Panels answer with a Clash config, base64 of share links, plain
// share links, SIP008 JSON or a sing-box config, depending on the URL and the client asking.
// Share links and SIP008 servers are read into the proxy dicts a Clash (mihomo) config holds, so
// src/clash.ts does the conversion to sing-box for every format. The link parsing follows
// mihomo's common/convert and Sub-Store's parsers, which panels such as V2Board, Xboard and
// SSPanel are tested against.

import { importClashConfig } from "./clash";
import type { ImportResult } from "./importer";

type Json = Record<string, any>;

const LINK = /^[a-z][a-z0-9+.-]*:\/\/\S/i;

/** Standard or URL-safe base64, padded or not, as UTF-8 text; null when it isn't base64. */
export function decodeBase64(s: string): string | null {
  const b = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!b || !/^[A-Za-z0-9+/]*={0,2}$/.test(b) || b.length % 4 === 1) return null;
  try {
    const bin = atob(b.replace(/=+$/, "").padEnd(Math.ceil(b.replace(/=+$/, "").length / 4) * 4, "="));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Share links one per line, as plain text or base64; the first line decides. */
export function shareLinks(text: string): string[] | null {
  const lines = (t: string) =>
    t
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter(Boolean);
  const plain = lines(text);
  if (plain.length && LINK.test(plain[0])) return plain;
  const decoded = plain.length ? decodeBase64(text) : null;
  if (decoded === null) return null;
  const inner = lines(decoded);
  return inner.length && LINK.test(inner[0]) ? inner : null;
}

/** A share link split into its parts, without the URL parser's rules for special schemes. */
interface Link {
  scheme: string;
  /** Still percent-encoded: some userinfo is base64, which may hold `%`-free `=`. */
  user: string;
  host: string;
  /** As written: hysteria2 links may carry a list of ports and ranges. */
  port: string;
  query: Map<string, string>;
  name: string;
  /** Everything between `://` and the query, for formats that don't follow URL syntax. */
  body: string;
}

function splitLink(s: string): Link {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^#]*)(?:#(.*))?$/is.exec(s);
  if (!m) throw new Error("链接格式无效");
  const [, scheme, rest, frag = ""] = m;
  const q = rest.indexOf("?");
  const body = (q < 0 ? rest : rest.slice(0, q)).replace(/\/+$/, "");
  const query = new Map<string, string>();
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split("&")) {
      if (!pair) continue;
      const i = pair.indexOf("=");
      // Keys are matched loosely: panels write both `allowInsecure` and `allow_insecure`.
      const key = decode(i < 0 ? pair : pair.slice(0, i)).toLowerCase().replace(/_/g, "-");
      if (!query.has(key)) query.set(key, decode(i < 0 ? "" : pair.slice(i + 1)));
    }
  }
  const at = body.lastIndexOf("@");
  const user = at < 0 ? "" : body.slice(0, at);
  const hostPort = at < 0 ? body : body.slice(at + 1);
  const hp = /^\[([^\]]+)\](?::(.*))?$/.exec(hostPort) ?? /^([^:]*)(?::(.*))?$/.exec(hostPort)!;
  return { scheme: scheme.toLowerCase(), user, host: decode(hp[1]), port: hp[2] ?? "", query, name: decode(frag).trim(), body };
}

/** The first of several query keys that is set; keys as `splitLink` stores them. */
const param = (l: Link, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = l.query.get(k);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};
const flag = (v: string | undefined) => !!v && /^(1|true|yes)$/i.test(v);
const csv = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

function port(l: Link, fallback?: number): number {
  const n = parseInt(l.port, 10);
  if (Number.isFinite(n)) return n;
  if (fallback !== undefined) return fallback;
  throw new Error("缺少端口");
}

/** Drops unset fields, so the proxy dict reads like one written by hand. */
const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

/** TLS and REALITY fields shared by the V2Ray-style links (vless, trojan, vmess in URI form). */
function tlsFields(l: Link, on: boolean): Json {
  if (!on) return {};
  const pbk = param(l, "pbk", "public-key");
  const ech = param(l, "ech");
  return clean({
    tls: true,
    servername: param(l, "sni", "peer", "servername"),
    "client-fingerprint": param(l, "fp", "fingerprint"),
    alpn: csv(param(l, "alpn")),
    "skip-cert-verify": flag(param(l, "allowinsecure", "insecure", "allow-insecure", "skip-cert-verify")) || undefined,
    // A short ID stays a string: `08` is not the number 8.
    "reality-opts": pbk ? clean({ "public-key": pbk, "short-id": param(l, "sid", "short-id") }) : undefined,
    "ech-opts": ech ? { enable: true, config: ech } : undefined,
  });
}

/** The transport of a V2Ray-style link: `type`, `host`, `path`, `serviceName`. */
function transportFields(net: string, host: string | undefined, path: string | undefined, o: { headerType?: string; ed?: string; service?: string }): Json {
  switch (net) {
    case "":
    case "tcp":
      return o.headerType === "http"
        ? { network: "http", "http-opts": clean({ path: [path || "/"], headers: host ? { Host: csv(host) } : undefined }) }
        : {};
    case "ws":
    case "httpupgrade": {
      const ed = parseInt(o.ed ?? "", 10);
      return {
        network: "ws",
        "ws-opts": clean({
          path: path || undefined,
          headers: host ? { Host: host } : undefined,
          "v2ray-http-upgrade": net === "httpupgrade" || undefined,
          "max-early-data": net === "ws" && ed > 0 ? ed : undefined,
          "early-data-header-name": net === "ws" && ed > 0 ? "Sec-WebSocket-Protocol" : undefined,
        }),
      };
    }
    case "grpc":
      return { network: "grpc", "grpc-opts": clean({ "grpc-service-name": o.service ?? path }) };
    case "h2":
    case "http":
      return { network: "h2", "h2-opts": clean({ host: csv(host), path: path || undefined }) };
    default:
      // xhttp, kcp, quic: kept so the Clash converter names the transport sing-box lacks.
      return { network: net };
  }
}

function vless(l: Link, type: "vless" | "trojan" | "vmess"): Json {
  if (!l.user || !l.host) throw new Error("链接格式无效");
  const security = param(l, "security") ?? (type === "trojan" ? "tls" : "none");
  const net = (param(l, "type") ?? "tcp").toLowerCase();
  return clean({
    type,
    server: l.host,
    port: port(l, 443),
    ...(type === "trojan" ? { password: decode(l.user) } : { uuid: decode(l.user) }),
    ...(type === "vmess" ? { alterId: 0, cipher: param(l, "encryption") ?? "auto" } : {}),
    flow: type === "vless" ? param(l, "flow") : undefined,
    encryption: type === "vless" ? param(l, "encryption") : undefined,
    "packet-encoding": param(l, "packetencoding"),
    udp: true,
    ...tlsFields(l, security === "tls" || security === "reality" || security === "xtls"),
    ...transportFields(net, param(l, "host"), param(l, "path"), {
      headerType: param(l, "headertype"),
      ed: param(l, "ed"),
      service: param(l, "servicename"),
    }),
  });
}

/** vmess:// as v2rayN writes it (base64 JSON), or in the URI form Xray proposed. */
function vmess(s: string): Json {
  const l = splitLink(s);
  const json = decodeBase64(decode(l.body));
  if (json === null) return { name: l.name, ...vless(l, "vmess") };
  let v: Json;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error("链接格式无效");
  }
  const str = (x: unknown) => (x === undefined || x === null ? "" : String(x).trim());
  const net = str(v.net).toLowerCase() || "tcp";
  let host = str(v.host);
  let path = str(v.path);
  // Version 1 links put both in `host`, separated by a semicolon.
  if (str(v.v) === "1" && host.includes(";") && !path) [host, path] = host.split(";");
  const tlsOn = str(v.tls).toLowerCase() === "tls";
  // v2rayN sends the Host header's name as SNI when none is given.
  const sni = str(v.sni) || (net === "ws" || net === "httpupgrade" || net === "h2" || net === "http" ? host.split(",")[0] : "") || undefined;
  return clean({
    name: l.name || str(v.ps),
    type: "vmess",
    server: str(v.add),
    port: parseInt(str(v.port), 10),
    uuid: str(v.id),
    alterId: parseInt(str(v.aid), 10) || 0,
    cipher: str(v.scy) || "auto",
    udp: true,
    ...(tlsOn
      ? clean({
          tls: true,
          servername: sni,
          "client-fingerprint": str(v.fp) || undefined,
          alpn: csv(str(v.alpn)),
          "skip-cert-verify": flag(str(v.allowInsecure ?? v.skipCertVerify)) || undefined,
        })
      : {}),
    // `type` is the camouflage of a TCP transport, and the gRPC mode otherwise.
    ...transportFields(net, host || undefined, path || undefined, { headerType: str(v.type), service: path }),
  });
}

/** `obfs-local;obfs=http;obfs-host=x` as mihomo's `plugin` and `plugin-opts`. */
function ssPlugin(spec: string): Json {
  const [name, ...parts] = spec.split(";");
  const opts = new Map(
    parts.map((p) => {
      const i = p.indexOf("=");
      return (i < 0 ? [p, "true"] : [p.slice(0, i), p.slice(i + 1)]) as [string, string];
    }),
  );
  if (name === "obfs-local" || name === "simple-obfs" || name === "obfs") {
    return { plugin: "obfs", "plugin-opts": clean({ mode: opts.get("obfs") ?? "http", host: opts.get("obfs-host") }) };
  }
  if (name === "v2ray-plugin") {
    return {
      plugin: "v2ray-plugin",
      "plugin-opts": clean({
        mode: opts.get("mode") ?? "websocket",
        host: opts.get("host"),
        path: opts.get("path"),
        tls: opts.has("tls") || undefined,
        mux: flag(opts.get("mux")) || undefined,
      }),
    };
  }
  return { plugin: name };
}

/** ss:// in SIP002 form (userinfo in base64, or percent-encoded for 2022 ciphers) or the legacy one. */
function shadowsocks(s: string): Json {
  let l = splitLink(s);
  if (!l.user) {
    // Legacy: the whole `method:password@host:port` in base64.
    const inner = decodeBase64(decode(l.body));
    if (inner === null || !inner.includes("@")) throw new Error("链接格式无效");
    const q = s.indexOf("?");
    l = { ...splitLink(`ss://${inner}${q < 0 ? "" : s.slice(q).replace(/#.*$/, "")}`), name: l.name };
  }
  const plain = decode(l.user);
  const userinfo = plain.includes(":") ? plain : decodeBase64(plain);
  if (!userinfo || !userinfo.includes(":")) throw new Error("链接格式无效");
  const i = userinfo.indexOf(":");
  const plugin = param(l, "plugin");
  return clean({
    type: "ss",
    server: l.host,
    port: port(l),
    cipher: userinfo.slice(0, i),
    password: userinfo.slice(i + 1),
    udp: true,
    "udp-over-tcp": flag(param(l, "uot", "udp-over-tcp")) || undefined,
    ...(plugin ? ssPlugin(plugin) : {}),
  });
}

function hysteria2(l: Link): Json {
  // The port may be a list of ports and ranges for port hopping; Xboard puts that in `mport`.
  const ports = /[,-]/.test(l.port) ? l.port : param(l, "mport");
  return clean({
    type: "hysteria2",
    server: l.host,
    port: parseInt(l.port, 10) || parseInt(ports ?? "", 10) || 443,
    ports,
    password: decode(l.user),
    obfs: param(l, "obfs"),
    "obfs-password": param(l, "obfs-password"),
    sni: param(l, "sni", "peer"),
    "skip-cert-verify": flag(param(l, "insecure", "allowinsecure")) || undefined,
    alpn: csv(param(l, "alpn")),
    fingerprint: param(l, "pinsha256"),
    up: param(l, "up", "upmbps"),
    down: param(l, "down", "downmbps"),
  });
}

function hysteria(l: Link): Json {
  const obfs = param(l, "obfsparam") ?? (param(l, "obfs") !== "xplus" ? param(l, "obfs") : undefined);
  return clean({
    type: "hysteria",
    server: l.host,
    port: port(l, 443),
    ports: param(l, "mport"),
    protocol: param(l, "protocol"),
    "auth-str": param(l, "auth"),
    obfs,
    sni: param(l, "peer", "sni"),
    "skip-cert-verify": flag(param(l, "insecure", "allowinsecure")) || undefined,
    alpn: csv(param(l, "alpn")),
    up: param(l, "upmbps", "up"),
    down: param(l, "downmbps", "down"),
  });
}

function tuic(l: Link): Json {
  const user = decode(l.user);
  const i = user.indexOf(":");
  return clean({
    type: "tuic",
    server: l.host,
    port: port(l),
    uuid: i < 0 ? user : user.slice(0, i),
    password: i < 0 ? undefined : user.slice(i + 1),
    "congestion-controller": param(l, "congestion-control", "congestion-controller"),
    "udp-relay-mode": param(l, "udp-relay-mode"),
    sni: param(l, "sni"),
    "skip-cert-verify": flag(param(l, "allow-insecure", "insecure", "allowinsecure")) || undefined,
    alpn: csv(param(l, "alpn")),
  });
}

/** `user:password`, percent-encoded or in base64 as some panels write it. */
function credentials(l: Link): Json {
  const plain = decode(l.user);
  const pair = plain.includes(":") ? plain : (decodeBase64(plain) ?? plain);
  const i = pair.indexOf(":");
  return clean({ username: i < 0 ? pair : pair.slice(0, i), password: i < 0 ? undefined : pair.slice(i + 1) });
}

function wireguard(l: Link): Json {
  const address = csv(param(l, "address", "ip")) ?? [];
  const reserved = csv(param(l, "reserved"));
  return clean({
    type: "wireguard",
    server: l.host,
    port: port(l),
    "private-key": decode(l.user),
    "public-key": param(l, "publickey", "public-key"),
    "pre-shared-key": param(l, "presharedkey", "pre-shared-key"),
    ip: address.find((a) => !a.includes(":")),
    ipv6: address.find((a) => a.includes(":")),
    reserved: reserved ? reserved.map(Number) : undefined,
    mtu: parseInt(param(l, "mtu") ?? "", 10) || undefined,
    udp: true,
  });
}

/** The remarks of an ssr:// link, so the skipped list can name it. */
function ssrName(s: string): string {
  const inner = decodeBase64(s.slice("ssr://".length)) ?? "";
  const remarks = /[?&]remarks=([^&]*)/.exec(inner)?.[1];
  return (remarks && decodeBase64(remarks)) || inner.split(":")[0] || "ssr";
}

/** One share link as a Clash proxy dict, named by its fragment or, failing that, its server. */
export function linkToProxy(s: string): Json {
  const scheme = s.slice(0, s.indexOf(":")).toLowerCase();
  let p: Json;
  switch (scheme) {
    case "ss":
      p = { name: splitLink(s).name, ...shadowsocks(s) };
      break;
    case "ssr":
      return { name: ssrName(s), type: "ssr" };
    case "vmess":
      p = vmess(s);
      break;
    case "vless":
    case "trojan": {
      const l = splitLink(s);
      p = { name: l.name, ...vless(l, scheme) };
      break;
    }
    default: {
      const l = splitLink(s);
      const body = (): Json => {
        switch (scheme) {
          case "hysteria2":
          case "hy2":
            return hysteria2(l);
          case "hysteria":
          case "hy":
            return hysteria(l);
          case "tuic":
            return tuic(l);
          case "anytls":
            return clean({
              type: "anytls",
              server: l.host,
              port: port(l, 443),
              password: decode(l.user),
              sni: param(l, "sni", "peer"),
              "skip-cert-verify": flag(param(l, "insecure", "allowinsecure")) || undefined,
              "client-fingerprint": param(l, "fp"),
              alpn: csv(param(l, "alpn")),
            });
          case "socks":
          case "socks5":
          case "socks5h":
            return { type: "socks5", server: l.host, port: port(l, 1080), ...credentials(l), udp: true };
          case "http":
          case "https":
            return clean({ type: "http", server: l.host, port: port(l, scheme === "https" ? 443 : 80), ...credentials(l), tls: scheme === "https" || undefined });
          case "wireguard":
          case "wg":
            return wireguard(l);
          default:
            return { type: scheme };
        }
      };
      p = { name: l.name, ...body() };
    }
  }
  if (!p.name) p.name = p.server ? `${p.server}:${p.port}` : scheme;
  return p;
}

/** SIP008's servers as Shadowsocks proxies. */
function sip008(o: Json): Json[] {
  return (Array.isArray(o.servers) ? o.servers : []).map((s: Json, i: number) =>
    clean({
      name: s.remarks || s.id || `${s.server}:${s.server_port}` || `ss-${i + 1}`,
      type: "ss",
      server: s.server,
      port: s.server_port,
      cipher: s.method,
      password: s.password,
      udp: true,
      ...(s.plugin ? ssPlugin([s.plugin, s.plugin_opts].filter(Boolean).join(";")) : {}),
    }),
  );
}

export const isSip008 = (o: unknown): o is Json =>
  !!o && typeof o === "object" && Array.isArray((o as Json).servers) && !("outbounds" in o) && !("proxies" in o);

/** Proxies as a Clash config, so the Clash importer converts them and reports what it skipped. */
function importProxies(proxies: Json[], notes: string[]): ImportResult {
  // Names must be unique for groups and detours; panels sometimes repeat them.
  const seen = new Map<string, number>();
  for (const p of proxies) {
    const n = (seen.get(p.name) ?? 0) + 1;
    seen.set(p.name, n);
    if (n > 1) p.name = `${p.name} ${n}`;
  }
  if (!proxies.length) throw new Error(notes.length ? notes.join("；") : "没有找到节点");
  const r = importClashConfig({ proxies });
  return { ...r, notes: [...notes, ...r.notes] };
}

export function importShareLinks(links: string[]): ImportResult {
  // The subscription URL itself, pasted where its content should go.
  if (links.length === 1 && /^https?:\/\/[^/?#]+[/?]./i.test(links[0])) {
    throw new Error("这是一个网址，不是订阅内容。本页面不联网：请先用浏览器或 curl 打开订阅地址，再把得到的内容粘贴进来");
  }
  const proxies: Json[] = [];
  const bad: string[] = [];
  for (const s of links) {
    if (!LINK.test(s)) continue;
    try {
      proxies.push(linkToProxy(s));
    } catch (e) {
      bad.push(`${s.slice(0, 40)}${s.length > 40 ? "…" : ""}（${(e as Error).message}）`);
    }
  }
  return importProxies(proxies, bad.length ? [`无法解析的链接，已跳过：${bad.join("、")}`] : []);
}

export function importSip008(o: Json): ImportResult {
  return importProxies(sip008(o), []);
}

/** A ready-made `curl` command fetching the subscription as a Clash (mihomo) client would. */
export function curlCommand(url: string): string {
  return `curl -fsSL -A 'clash.meta' '${url.replace(/'/g, "'\\''")}' -o subscription.yaml`;
}
