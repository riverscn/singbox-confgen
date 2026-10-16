// Walks route rules for a connection to an IP address (no sniffed domain) to see where it ends.
// IP prefixes are matched for real (inline rule-sets included); remote rule-sets other than
// geoip-cn never match, and geoip-cn is whatever the connection says.

import { BlockList, isIPv6 } from "node:net";

type Json = Record<string, any>;

export interface Connection {
  mode: "Direct" | "GFWList" | "Non-CN" | "Global";
  ip: string;
  port?: number;
  /** The address is in geoip-cn. */
  cn?: boolean;
  /** This device has a public IPv6 address. */
  publicV6Iface?: boolean;
}

const list = (v: unknown): any[] => ([] as any[]).concat(v ?? []);

function inPrefixes(ip: string, prefixes: string[]): boolean {
  const block = new BlockList();
  for (const p of prefixes) {
    const [addr, len] = p.split("/");
    const type = isIPv6(addr) ? "ipv6" : "ipv4";
    block.addSubnet(addr, Number(len ?? (type === "ipv6" ? 128 : 32)), type);
  }
  return block.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
}

function inRuleSet(tag: string, config: Json, c: Connection): boolean {
  if (tag === "geoip-cn") return !!c.cn;
  const set = config.route.rule_set.find((r: Json) => r.tag === tag);
  if (set?.type !== "inline") return false;
  return set.rules.some((r: Json) => r.ip_cidr && inPrefixes(c.ip, r.ip_cidr));
}

function matches(rule: Json, config: Json, c: Connection): boolean {
  let ok: boolean;
  if (rule.type === "logical") {
    const results = rule.rules.map((r: Json) => matches(r, config, c));
    ok = rule.mode === "and" ? results.every(Boolean) : results.some(Boolean);
  } else {
    ok = Object.entries(rule).every(([k, v]) => {
      switch (k) {
        case "action":
        case "outbound":
        case "method":
        case "no_drop":
        case "invert":
          return true;
        case "clash_mode":
          return c.mode === v;
        case "network":
          return list(v).includes("tcp");
        case "ip_version":
          return v === (isIPv6(c.ip) ? 6 : 4);
        case "ip_cidr":
          return inPrefixes(c.ip, list(v));
        case "rule_set":
          return list(v).some((tag) => inRuleSet(tag, config, c));
        case "default_interface_address":
          return !!c.publicV6Iface;
        case "port":
          return list(v).includes(c.port ?? 443);
        case "ip_is_private":
          return false;
        // Needs a sniffed domain or protocol, or a tailnet peer: none here.
        default:
          return false;
      }
    });
  }
  return rule.invert ? !ok : ok;
}

/** The first final action the connection reaches: "reject" or "route:<outbound>". */
export function routeWalk(config: Json, c: Connection): string {
  for (const rule of config.route.rules) {
    if (rule.action === "sniff" || rule.action === "hijack-dns") continue;
    if (!matches(rule, config, c)) continue;
    return rule.action === "route" ? `route:${rule.outbound}` : rule.action;
  }
  return `route:${config.route.final}`;
}
