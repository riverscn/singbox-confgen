// Walks DNS rules for an abstract query to see which servers get asked and where it ends.
// Response-dependent conditions (match_response) are "unknown": rules gated on them are skipped
// for terminal decisions, but their evaluates are still recorded as possible queries.

type Json = Record<string, any>;
type Tri = boolean | undefined;

export interface Query {
  mode: "Direct" | "GFWList" | "Non-CN" | "Global";
  qtype: "A" | "AAAA" | "HTTPS" | "SVCB";
  gfw?: boolean;
  cnSite?: boolean;
  steam?: boolean;
  customDirect?: boolean;
  /** Listed in the custom proxy domains. */
  customProxy?: boolean;
  /** Listed in a rule that sends it to a node or group. */
  ruleDomain?: boolean;
  /** Listed in a DNS rule; the walk reports its server as `dns-rule`. */
  dnsRule?: boolean;
  /** Tags of the other rule-sets holding the domain (e.g. a rule's `geosite-openai`). */
  sets?: string[];
  publicV6Iface?: boolean;
}

export interface Walk {
  /** Servers queried by evaluate rules whose own condition is known to match. */
  evaluated: string[];
  /** First unconditional terminal action reached. */
  final: string;
}

const not = (v: Tri): Tri => (v === undefined ? undefined : !v);

function leaf(rule: Json, q: Query): Tri {
  if ("match_response" in rule) return undefined;
  const checks: Tri[] = [];
  for (const [k, v] of Object.entries(rule)) {
    switch (k) {
      case "clash_mode":
        checks.push(q.mode === v);
        break;
      case "query_type":
        checks.push(([] as string[]).concat(v).includes(q.qtype));
        break;
      case "rule_set": {
        const sets = ([] as string[]).concat(v);
        checks.push(
          sets.some((s) =>
            s === "gfwlist"
              ? !!q.gfw
              : s === "gfwlist-custom-domains"
                ? !!q.customProxy
              : s === "geosite-geolocation-cn"
                ? !!q.cnSite
                : s === "custom-direct-domains"
                  ? !!q.customDirect
                  : s === "custom-rule-domains"
                    ? !!q.ruleDomain
                    : s === "custom-dns-domains"
                      ? !!q.dnsRule
                      : !!q.sets?.includes(s),
          ),
        );
        break;
      }
      case "domain_suffix":
        checks.push(([] as string[]).includes.call(v, "steamcontent.com") ? !!q.steam : ([] as string[]).includes.call(v, "dns-rule.test") ? !!q.dnsRule : false);
        break;
      case "domain":
      case "preferred_by":
        checks.push(false);
        break;
      case "default_interface_address":
        checks.push(!!q.publicV6Iface);
        break;
    }
  }
  return checks.every((c) => c === true) ? true : checks.some((c) => c === false) ? false : undefined;
}

export function match(rule: Json, q: Query): Tri {
  let r: Tri;
  if (rule.type === "logical") {
    const parts = (rule.rules as Json[]).map((x) => match(x, q));
    if (rule.mode === "and") r = parts.includes(false) ? false : parts.every((p) => p === true) ? true : undefined;
    else r = parts.includes(true) ? true : parts.every((p) => p === false) ? false : undefined;
  } else {
    r = leaf(rule, q);
  }
  return rule.invert ? not(r) : r;
}

export function walk(rules: Json[], q: Query): Walk {
  const evaluated: string[] = [];
  for (const rule of rules) {
    const m = match(rule, q);
    if (m === false) continue;
    if (rule.action === "evaluate") {
      if (m === true) evaluated.push(rule.server);
      continue;
    }
    if (m !== true || rule.action === "route-options") continue;
    if (rule.action === "route") return { evaluated, final: `route:${rule.server}` };
    if (rule.action === "respond") return { evaluated, final: "respond" };
    return { evaluated, final: `${rule.action}:${rule.rcode ?? ""}` };
  }
  return { evaluated, final: "fallthrough" };
}
