import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateConfig, jsonErrorOffset, nodeObject, parseDomainList, parseJsonc, parseRuleList, stripComments, validate } from "../src/generate";
import { blueprintProfile, newDnsRule, newGroup, newNode, newRule, newTailnet } from "../src/defaults";
import { normalizeProfile } from "../src/storage";
import { TEMPLATES, NODE_TYPES } from "../src/templates";
import type { Profile, Tailnet } from "../src/types";
import { normalize } from "./normalize";
import { walk, type Query } from "./dnswalk";
import { filledBody } from "./samples";
import { routeWalk, type Connection } from "./routewalk";

// SFM's tiger.json (sanitized) before the DNS redesign. Non-DNS parts must still match it.
const baseline = normalize(JSON.parse(readFileSync(new URL("./fixtures/tiger-baseline.json", import.meta.url), "utf8"))) as any;
const gen = (p: Profile = blueprintProfile()) => generateConfig(p) as any;

/** The author's own settings, entered the way a user would, reproducing the baseline. */
function personalProfile(): Profile {
  // The baseline's servers, saved by the v1 form editor; loading migrates them to JSON nodes.
  const p = normalizeProfile({
    servers: [
      { name: "us-la-99", host: "us-la-99.example.com" },
      { name: "us-la3-zgo", host: "us-la3-zgo.example.com" },
    ],
  });
  p.settings.clashSecret = ""; // the baseline ran without one
  p.settings.steam = true;
  p.settings.blockIcloudQuic = true;
  p.settings.tailnets = [
    newTailnet({
      tag: "home",
      endpoint: `{
        // home tailnet
        "state_directory": "tailscale-main",
        "hostname": "my-mac",
        "accept_routes": true
      }`,
    }),
    newTailnet({
      tag: "work",
      endpoint: `{
        "state_directory": "tailscale-secondary",
        "hostname": "my-mac-2",
        "accept_routes": true,
        "exit_node_allow_lan_access": true
      }`,
      exitNode: "office-gw",
      acceptDefaultResolvers: true,
      dnsDomains: ["corp.example.com"],
    }),
  ];
  return p;
}

const usesCustomList = (r: any) => /custom-direct-domains|"gfwlist-custom-(domains|ips)"\]/.test(JSON.stringify(r)) && r.outbound === "proxy";

describe("personal settings reproduce the baseline outside DNS", () => {
  const out = normalize(gen(personalProfile())) as any;
  it.each(["log", "http_clients", "endpoints", "inbounds"])("%s", (key) => {
    expect(out[key]).toEqual(baseline[key]);
  });
  it("route, apart from the custom lists and the dropped IPv6 group", () => {
    const isCustomDirect = (r: any) => JSON.stringify(r).includes("custom-direct-domains");
    expect(out.route.rules.filter((r: any) => !isCustomDirect(r) && !usesCustomList(r))).toEqual(
      baseline.route.rules.filter((r: any) => r.outbound !== "proxy-v6"),
    );
    expect(out.route.rule_set.filter((r: any) => !isCustomDirect(r))).toEqual(baseline.route.rule_set);
    const { rule_set: _a, rules: _b, ...rest } = out.route;
    const { rule_set: _c, rules: _d, ...baseRest } = baseline.route;
    expect(rest).toEqual(baseRest);
  });
  it("outbounds, apart from resolving proxy hosts locally and dropping the IPv6 group", () => {
    const expected = baseline.outbounds
      .filter((o: any) => o.tag !== "proxy-v6")
      .map((o: any) => (o.domain_resolver === "cn-dns" ? { ...o, domain_resolver: "local" } : o));
    expect(out.outbounds).toEqual(expected);
  });
  it("experimental", () => {
    expect(out.experimental).toEqual(baseline.experimental);
  });
  it("tailnet DNS servers and rules", () => {
    const tsServers = baseline.dns.servers.filter((s: any) => s.type === "tailscale");
    expect(out.dns.servers.filter((s: any) => s.type === "tailscale")).toEqual(tsServers);
    expect(out.dns.rules.slice(0, 3)).toEqual(baseline.dns.rules.slice(0, 3));
  });
});

describe("default profile carries no personal settings", () => {
  const text = JSON.stringify(gen());
  it.each(['"home"', '"work"', "my-mac", "office-gw", "corp.example.com", "lancache", "steamcontent", "icloud", "tailscale", 'preferred_by":[', "endpoints"])(
    "does not mention %s",
    (word) => expect(text).not.toContain(word),
  );
  it("still resolves local-network names locally", () => {
    expect(gen().dns.rules[0]).toEqual({ preferred_by: "local", action: "route", server: "local" });
  });
});

describe("DNS", () => {
  const dns = gen(personalProfile()).dns;
  const rules: any[] = dns.rules;
  const QTYPES = ["A", "AAAA", "HTTPS", "SVCB"] as const;
  const all = (q: Omit<Query, "qtype">) => QTYPES.map((qtype) => walk(rules, { ...q, qtype }));
  const IPV6_CARRIERS = ["AAAA", "HTTPS", "SVCB"] as const;

  it("has no domestic DoH or IPv6 probe server and references only defined servers", () => {
    const servers = new Set(dns.servers.map((s: any) => s.tag));
    expect(servers.has("cn-dns")).toBe(false);
    expect(servers.has("google-v6-check")).toBe(false);
    for (const r of rules) if (r.server) expect(servers.has(r.server), r.server).toBe(true);
    expect(servers.has(dns.final)).toBe(true);
  });

  it("only matches responses of earlier evaluates", () => {
    const seen = new Set<string>();
    const visit = (r: any, top: any) => {
      if (typeof r.match_response === "string") expect(seen.has(r.match_response), JSON.stringify(top)).toBe(true);
      (r.rules ?? []).forEach((x: any) => visit(x, top));
    };
    for (const r of rules) {
      visit(r, r);
      if (r.action === "evaluate") seen.add(r.tag);
    }
  });

  it("follows the race/speculative constraints", () => {
    const hasMatchResponse = (r: any): boolean => "match_response" in r || (r.rules ?? []).some(hasMatchResponse);
    for (const r of rules) {
      if (r.race) expect(hasMatchResponse(r), JSON.stringify(r)).toBe(true);
      expect(r.race && r.speculative).toBeFalsy();
    }
  });

  it("sends no ECS by default, and the configured subnet only to the remote resolver", () => {
    expect(JSON.stringify(rules)).not.toContain("client_subnet");
    const p = blueprintProfile();
    p.settings.clientSubnet = "203.0.113.0/24";
    const withEcs = gen(p).dns.rules.filter((r: any) => r.client_subnet);
    expect(withEcs.map((r: any) => r.server)).toEqual(["remote"]);
  });

  it("Direct mode never depends on the proxy", () => {
    for (const w of all({ mode: "Direct", publicV6Iface: true })) expect(w).toEqual({ evaluated: [], final: "route:local" });
    expect(walk(rules, { mode: "Direct", qtype: "AAAA", publicV6Iface: false }).final).toBe("predefined:NOERROR");
  });

  it("GFWList: outside gfwlist uses only the local resolver, gfwlist only the remote one", () => {
    for (const w of all({ mode: "GFWList", publicV6Iface: true })) expect(w).toEqual({ evaluated: [], final: "route:local" });
    for (const w of all({ mode: "GFWList", gfw: true, publicV6Iface: true })) {
      expect(w.evaluated).not.toContain("local");
      expect(w.final).not.toBe("route:local");
    }
    expect(walk(rules, { mode: "GFWList", qtype: "A", gfw: true }).evaluated).toEqual(["remote"]);
  });

  it("Non-CN: domestic domains go local; others ask local and remote together", () => {
    for (const w of all({ mode: "Non-CN", cnSite: true, publicV6Iface: true })) expect(w.final).toBe("route:local");
    expect(walk(rules, { mode: "Non-CN", qtype: "A" }).evaluated).toEqual(["local", "remote"]);
    expect(walk(rules, { mode: "Non-CN", qtype: "AAAA" })).toEqual({ evaluated: ["local"], final: "predefined:NOERROR" });
    const remote = rules.filter((r) => r.action === "evaluate" && r.server === "remote");
    expect(remote.every((r) => r.speculative)).toBe(true);
  });

  it("Global: everything, even domestic domains, is resolved through the proxy", () => {
    for (const w of all({ mode: "Global", cnSite: true, publicV6Iface: true })) {
      expect(w.evaluated).not.toContain("local");
      expect(w.evaluated.every((s) => s === "remote")).toBe(true);
    }
  });

  it("proxied domains never get IPv6 addresses, HTTPS or SVCB records", () => {
    const proxied: Omit<Query, "qtype">[] = [{ mode: "GFWList", gfw: true }, { mode: "Non-CN" }, { mode: "Global" }, { mode: "Global", cnSite: true }];
    for (const q of proxied) {
      for (const qtype of IPV6_CARRIERS) {
        const w = walk(rules, { ...q, qtype, publicV6Iface: true });
        expect(w.final, `${JSON.stringify(q)} ${qtype}`).toBe("predefined:NOERROR");
        expect(w.evaluated).not.toContain("remote");
      }
      expect(walk(rules, { ...q, qtype: "A", publicV6Iface: true }).evaluated).toContain("remote");
    }
  });

  it("direct domains keep IPv6, HTTPS and SVCB from the local resolver", () => {
    const direct: Omit<Query, "qtype">[] = [{ mode: "Direct" }, { mode: "GFWList" }, { mode: "Non-CN", cnSite: true }];
    for (const q of direct) {
      for (const qtype of IPV6_CARRIERS) {
        expect(walk(rules, { ...q, qtype, publicV6Iface: true }), `${q.mode} ${qtype}`).toEqual({ evaluated: [], final: "route:local" });
      }
    }
  });

  it.each([
    ["google", "tls", { type: "tls", server: "8.8.8.8", server_port: 853, tls: { enabled: true, server_name: "dns.google" } }],
    ["cloudflare", "https", { type: "https", server: "1.1.1.1", server_port: 443, path: "/dns-query", tls: { enabled: true, server_name: "cloudflare-dns.com" } }],
    ["quad9", "tls", { type: "tls", server: "9.9.9.9", server_port: 853, tls: { enabled: true, server_name: "dns.quad9.net" } }],
  ] as const)("remote resolver %s over %s", (provider, protocol, expected) => {
    const p = blueprintProfile();
    p.settings.remoteDns = { provider, protocol };
    const server = gen(p).dns.servers.find((s: any) => s.tag === "remote");
    expect(server).toEqual({ ...expected, tag: "remote", detour: "proxy" });
  });
});

describe("proxy groups", () => {
  const setup = () => {
    const p = blueprintProfile();
    const [hy2, reality] = p.nodes;
    return { p, hy2, reality };
  };
  const byTag = (cfg: any) => Object.fromEntries(cfg.outbounds.map((o: any) => [o.tag, o]));

  it("adds groups after auto, offers them in proxy, and keeps proxy as the only entry point", () => {
    const { p, hy2, reality } = setup();
    const g = newGroup({ tag: "us", members: [reality.id, hy2.id], defaultMember: hy2.id });
    p.groups = [g];
    const cfg = gen(p);
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual(["proxy", "auto", "us", "hy2-1", "reality-1", "direct"]);
    expect(byTag(cfg).us).toEqual({ type: "selector", tag: "us", outbounds: ["reality-1", "hy2-1"], default: "hy2-1" });
    expect(byTag(cfg).proxy.outbounds).toEqual(["auto", "us", "hy2-1", "reality-1"]);
    // DNS, rule-set downloads and the final route still go through proxy.
    expect(cfg.dns.servers.find((s: any) => s.tag === "remote").detour).toBe("proxy");
    expect(cfg.route.final).toBe("proxy");
    expect(cfg.http_clients[0].detour).toBe("proxy");
  });

  it("uses a group as proxy's default and can hide individual nodes from proxy", () => {
    const { p, hy2 } = setup();
    const g = newGroup({ tag: "main", members: [hy2.id] });
    p.groups = [g];
    p.settings.proxyDefault = g.id;
    p.settings.listNodesInProxy = false;
    const proxy = byTag(gen(p)).proxy;
    expect(proxy).toEqual({ type: "selector", tag: "proxy", outbounds: ["auto", "main"], default: "main" });
  });

  it("can default to a listed node, and falls back to auto once nodes are no longer listed", () => {
    const { p, hy2 } = setup();
    p.settings.proxyDefault = hy2.id;
    expect(byTag(gen(p)).proxy.default).toBe(hy2.tag);
    p.settings.listNodesInProxy = false;
    expect(byTag(gen(p)).proxy.default).toBe("auto");
  });

  it("falls back to auto when the default group is gone", () => {
    const { p } = setup();
    p.settings.proxyDefault = "missing";
    expect(byTag(gen(p)).proxy.default).toBe("auto");
  });

  it("writes url-test settings with sing-box defaults for empty fields, and nests groups", () => {
    const { p, hy2, reality } = setup();
    const inner = newGroup({ tag: "inner", members: [hy2.id] });
    const outer = newGroup({ tag: "outer", type: "urltest", members: [reality.id, inner.id], tolerance: 120 });
    p.groups = [inner, outer];
    expect(byTag(gen(p)).outer).toEqual({
      type: "urltest",
      tag: "outer",
      outbounds: ["reality-1", "inner"],
      url: "https://www.gstatic.com/generate_204",
      interval: "3m",
      tolerance: 120,
      idle_timeout: "30m",
    });
  });

  it("drops members that no longer exist", () => {
    const { p, hy2 } = setup();
    p.groups = [newGroup({ tag: "g", members: ["gone", hy2.id], defaultMember: "gone" })];
    expect(byTag(gen(p)).g).toEqual({ type: "selector", tag: "g", outbounds: ["hy2-1"] });
  });

  it("validates empty groups, cycles, names and url-test fields", () => {
    const { p, hy2 } = setup();
    const a = newGroup({ tag: "a" });
    const b = newGroup({ tag: "b", members: [hy2.id] });
    const c = newGroup({ tag: "c", members: [b.id] });
    b.members.push(c.id);
    const d = newGroup({ tag: "hy2-1", type: "urltest", members: [hy2.id], interval: "five", tolerance: -1 });
    p.groups = [a, b, c, d];
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain("代理组「a」：还没有成员");
    expect(msgs).toContain("代理组「b」：和其他代理组互相包含");
    expect(msgs).toContain("代理组「c」：和其他代理组互相包含");
    expect(msgs).toContain("标签重复：hy2-1");
    expect(msgs).toContain("测速间隔「five」格式不对");
    expect(msgs).toContain("容差必须是非负整数");
    expect(validate(p).find((i) => i.message.includes("「a」"))?.section).toBe("groups");
    expect(validate(p).find((i) => i.message.includes("「a」"))?.level).toBe("warning");
  });

  it("leaves out groups without usable members instead of breaking the config", () => {
    const { p, hy2 } = setup();
    const empty = newGroup({ tag: "empty" });
    const outer = newGroup({ tag: "outer", members: [empty.id] });
    const real = newGroup({ tag: "real", members: [empty.id, hy2.id] });
    p.groups = [empty, outer, real];
    p.settings.proxyDefault = empty.id;
    const out = byTag(gen(p));
    expect(out.empty).toBeUndefined();
    expect(out.outer).toBeUndefined();
    expect(out.real.outbounds).toEqual(["hy2-1"]);
    expect(out.proxy.outbounds).not.toContain("empty");
    expect(out.proxy.default).toBe("auto");
    expect(validate(p).find((i) => i.message.includes("「outer」"))?.detail).toBe("成员里只有空的代理组，暂不写入配置");
  });
});

describe("custom remote DNS server", () => {
  const withCustom = (custom: string) => {
    const p = blueprintProfile();
    p.settings.remoteDns = { ...p.settings.remoteDns, provider: "custom", custom };
    return p;
  };

  it("uses the JSON body, filling in tag and the proxy detour", () => {
    const cfg = gen(withCustom('{ // mine\n "type": "quic", "server": "9.9.9.9", "tls": {"enabled": true, "server_name": "dns.quad9.net"} }'));
    expect(cfg.dns.servers.find((s: any) => s.tag === "remote")).toEqual({
      type: "quic",
      tag: "remote",
      server: "9.9.9.9",
      tls: { enabled: true, server_name: "dns.quad9.net" },
      detour: "proxy",
    });
  });

  it("keeps an explicit detour", () => {
    const cfg = gen(withCustom('{"type":"udp","server":"10.0.0.53","detour":"direct"}'));
    expect(cfg.dns.servers.find((s: any) => s.tag === "remote").detour).toBe("direct");
  });

  it("reports a broken body and falls back to Google so the config still loads", () => {
    const p = withCustom('{"type":"doh","server":"x"}');
    expect(validate(p).map((i) => i.message).join()).toContain("自定义代理 DNS 服务器：type 必须是");
    expect(gen(p).dns.servers.find((s: any) => s.tag === "remote").server).toBe("8.8.8.8");
  });
});

describe("DNS rules", () => {
  const withDnsRules = (...rules: Parameters<typeof newDnsRule>[0][]) => {
    const p = blueprintProfile();
    p.settings.dnsRules = rules.map((r) => newDnsRule(r));
    return p;
  };
  const QTYPES = ["A", "AAAA", "HTTPS", "SVCB"] as const;

  it("leaves the config as it was without rules", () => {
    const cfg = gen();
    expect(JSON.stringify(cfg)).not.toContain("custom-dns-domains");
    expect(cfg.dns.servers.map((s: any) => s.tag)).toEqual(["local", "remote"]);
  });

  it("adds a custom server, reached directly unless it names a detour, and routes listed domains to it", () => {
    const cfg = gen(
      withDnsRules(
        { custom: '{ // office\n "type": "udp", "server": "10.0.0.53" }', lines: ["corp.example.com", "domain:wiki.example.net"] },
        { custom: '{"type":"tls","server":"9.9.9.9","detour":"proxy"}', lines: ["example.org"] },
      ),
    );
    expect(cfg.dns.servers.slice(2)).toEqual([
      { type: "udp", tag: "dns-rule-1", server: "10.0.0.53" },
      { type: "tls", tag: "dns-rule-2", server: "9.9.9.9", detour: "proxy" },
    ]);
    const routes = cfg.dns.rules.filter((r: any) => r.action === "route" && String(r.server).startsWith("dns-rule"));
    expect(routes).toEqual([
      { domain_suffix: ["corp.example.com"], domain: ["wiki.example.net"], action: "route", server: "dns-rule-1" },
      { domain_suffix: ["example.org"], action: "route", server: "dns-rule-2" },
    ]);
    expect(cfg.route.rule_set.find((r: any) => r.tag === "custom-dns-domains").rules).toEqual([
      { domain: ["wiki.example.net"], domain_suffix: ["corp.example.com"] },
      { domain_suffix: ["example.org"] },
    ].map((r) => expect.objectContaining(r)));
  });

  it("can use the local or proxy DNS without adding a server", () => {
    const cfg = gen(withDnsRules({ server: "local", lines: ["a.example"] }, { server: "remote", lines: ["b.example"] }));
    expect(cfg.dns.servers.map((s: any) => s.tag)).toEqual(["local", "remote"]);
    const routes = cfg.dns.rules.filter((r: any) => /^[ab]\.example$/.test(r.domain_suffix?.[0]));
    expect(routes.map((r: any) => r.server)).toEqual(["local", "remote"]);
  });

  it("comes after tailnet DNS only, so local-network names can go to the router", () => {
    const router = '{"type":"udp","server":"192.168.1.1"}';
    const p = withDnsRules({ custom: router, lines: [".", "lan", "home.arpa"] });
    p.settings.tailnets = [newTailnet({ dnsDomains: ["corp.example.com"] })];
    const rules: any[] = gen(p).dns.rules;
    const first = rules.findIndex((r) => JSON.stringify(r).includes("custom-dns-domains"));
    expect(rules.slice(0, first).every((r) => r.server === "ts-dns")).toBe(true);
    const route = rules.findIndex((r) => r.server === "dns-rule-1");
    expect(rules[route]).toEqual({ domain_suffix: ["lan", "home.arpa"], domain_regex: ["^[^.]+$"], action: "route", server: "dns-rule-1" });
    expect(route).toBeLessThan(rules.findIndex((r) => r.preferred_by === "local"));
    expect(route).toBeLessThan(rules.findIndex((r) => r.domain_suffix?.includes(".lan") && r.server === "local"));
  });

  it("keeps every answer for local-network names, as the local resolver does", () => {
    const p = withDnsRules({ custom: '{"type":"udp","server":"192.168.1.1"}', lines: ["lan"] });
    const ipv6 = gen(p).dns.rules.filter((r: any) => r.action === "predefined" && JSON.stringify(r).includes("custom-dns-domains"));
    expect(ipv6.length).toBeGreaterThan(0);
    for (const r of ipv6) {
      expect(JSON.stringify(r)).toContain('"domain_suffix":[".local",".lan",".localdomain",".home.arpa",".internal",".intranet"],"domain_regex":["^[^.]+$"],"invert":true');
    }
  });

  it("reads a lone . as device names without a dot", () => {
    expect(parseDomainList(".\n.lan").domains).toEqual({ domain: [], domain_suffix: [".lan"], domain_keyword: [], domain_regex: ["^[^.]+$"] });
  });

  it("asks the chosen server in every mode, and keeps the IPv6 policy of the route", () => {
    const p = withDnsRules({ custom: '{"type":"udp","server":"10.0.0.53"}', lines: ["dns-rule.test"] });
    p.settings.proxyRules = ["proxied.example"];
    const rules: any[] = gen(p).dns.rules;
    const ask = (q: Omit<Query, "qtype" | "dnsRule">, qtype: (typeof QTYPES)[number], v6 = true) =>
      walk(rules, { ...q, qtype, dnsRule: true, publicV6Iface: v6 }).final;
    for (const mode of ["Direct", "GFWList", "Non-CN", "Global"] as const) {
      expect(ask({ mode }, "A"), mode).toBe("route:dns-rule-1");
      expect(ask({ mode, gfw: true, cnSite: true }, "A"), mode).toBe("route:dns-rule-1");
    }
    // Goes direct: IPv6 as usual, unless there is no public IPv6 locally.
    for (const qtype of QTYPES) expect(ask({ mode: "GFWList" }, qtype)).toBe("route:dns-rule-1");
    expect(ask({ mode: "GFWList" }, "AAAA", false)).toBe("predefined:NOERROR");
    expect(ask({ mode: "Non-CN", cnSite: true }, "AAAA")).toBe("route:dns-rule-1");
    // Goes through the proxy, or might: IPv4 only.
    for (const q of [{ mode: "GFWList", gfw: true }, { mode: "Global" }, { mode: "Non-CN" }, { mode: "Non-CN", customProxy: true, cnSite: true }] as const) {
      expect(ask(q, "A")).toBe("route:dns-rule-1");
      for (const qtype of ["AAAA", "HTTPS", "SVCB"] as const) expect(ask(q, qtype), `${q.mode} ${qtype}`).toBe("predefined:NOERROR");
    }
    // Listed as direct too: direct wins, as in routing.
    expect(ask({ mode: "GFWList", gfw: true, customDirect: true }, "AAAA")).toBe("route:dns-rule-1");
  });

  it("starts from a template for an internal DNS behind a VPN node, and points tailnets to their split DNS", () => {
    const p = withDnsRules({ lines: ["corp.example.com"] });
    p.nodes.push(newNode({ tag: "wg", body: filledBody("wireguard") }));
    expect(validate(p).filter((i) => i.id === p.settings.dnsRules[0].id)).toEqual([]);
    expect(gen(p).dns.servers.find((s: any) => s.tag === "dns-rule-1")).toEqual({ type: "udp", tag: "dns-rule-1", server: "10.0.0.53" });
    p.settings.dnsRules[0].custom = '{"type":"udp","server":"10.0.0.53","detour":"wg"}';
    expect(validate(p).filter((i) => i.id === p.settings.dnsRules[0].id)).toEqual([]);
    p.settings.tailnets = [newTailnet({ tag: "office" })];
    p.settings.dnsRules[0].custom = '{"type":"udp","server":"10.0.0.53","detour":"office"}';
    expect(validate(p).find((i) => i.id === p.settings.dnsRules[0].id)).toMatchObject({ level: "warning", detail: expect.stringContaining("分域 DNS") });
  });

  it("leaves out rules without domains or with a broken server, and says why", () => {
    const p = withDnsRules(
      { lines: [] },
      { custom: '{"type":"doh","server":"x"}', lines: ["a.example"] },
      { custom: '{"type":"udp","server":"10.0.0.53","detour":"nope"}', lines: ["b.example"] },
      { custom: '{"type":"udp","server":"10.0.0.53","detour":"direct"}', lines: ["c.example"] },
      { server: "local", lines: ["1.2.3.4", "*.example.com"] },
    );
    const messages = validate(p).map((i) => i.message);
    expect(messages).toContain("DNS 规则 1：还没有填写域名，暂不写入配置");
    expect(messages.join()).toContain("DNS 规则 2：DNS 服务器：type 必须是");
    expect(messages).toContain("DNS 规则 3：detour 指向的「nope」不存在");
    expect(messages).toContain("DNS 规则 4：detour 不能是 direct：不写 detour 就是直连访问");
    expect(messages.join()).toContain("DNS 规则 5：域名格式不正确：1.2.3.4（这里只能填域名）");
    const cfg = gen(p);
    expect(cfg.dns.servers.map((s: any) => s.tag)).toEqual(["local", "remote", "dns-rule-3", "dns-rule-4"]);
    expect(cfg.dns.rules.some((r: any) => r.server === "dns-rule-2")).toBe(false);
  });

  it("survives saving and loading", () => {
    const p = withDnsRules({ server: "remote", lines: ["a.example"] });
    expect(normalizeProfile(JSON.parse(JSON.stringify(p))).settings.dnsRules).toEqual(p.settings.dnsRules);
    expect(normalizeProfile({ nodes: [] }).settings.dnsRules).toEqual([]);
  });
});

describe("custom direct domains", () => {
  const withList = (lines: string[]) => {
    const p = blueprintProfile();
    p.settings.directDomains = lines;
    return gen(p);
  };
  const ruleSet = (cfg: any) => cfg.route.rule_set.find((r: any) => r.tag === "custom-direct-domains");

  it("is an empty never-matching set by default", () => {
    expect(ruleSet(gen()).rules).toEqual([{ domain_regex: ["a^"] }]);
  });

  it("cleans and de-duplicates entries", () => {
    const cfg = withList(["Example.CN", "corp.example.com  # office", "", "example.cn", "a.b."]);
    expect(ruleSet(cfg).rules).toEqual([{ domain_suffix: ["example.cn", "corp.example.com", "a.b"] }]);
  });

  it("takes sing-box field names as prefixes, and a leading dot for subdomains only", () => {
    const cfg = withList([
      "domain:WWW.Example.org",
      "domain_suffix:example.net",
      ".example.net",
      "domain_keyword:Tracker, example.cn",
      "domain_regex:^cdn\\d{1,3}\\.example\\.com$  # CDN nodes",
      "domain_regex:^a#b$",
    ]);
    expect(ruleSet(cfg).rules).toEqual([
      {
        domain: ["www.example.org"],
        domain_suffix: ["example.net", ".example.net", "example.cn"],
        domain_keyword: ["tracker"],
        domain_regex: ["^cdn\\d{1,3}\\.example\\.com$", "^a#b$"],
      },
    ]);
  });

  it("rejects what sing-box cannot use, and says how to fix it", () => {
    const reason = (line: string, ip = false) => (ip ? parseRuleList(line) : parseDomainList(line)).invalid[0]?.reason;
    expect(reason("domain_regex:(?=x)")).toContain("环视");
    expect(reason("domain_regex:a(")).toBe("正则语法有误");
    expect(reason("domain_regex:(a)\\1")).toContain("反向引用");
    expect(reason("domain_regex:Upper")).toContain("小写");
    expect(reason("domain_regex:(?i)OK")).toBeUndefined();
    expect(reason("domain_regex:(?P<n>x)\\pL")).toBeUndefined();
    expect(reason("domain_keyword:a b")).toContain("关键字");
    expect(reason("domain:")).toBe("前缀后面缺少域名");
    expect(reason("*.example.com")).toBe("不支持通配符：只匹配子域名写 .example.com，连同它本身写 example.com");
    expect(reason("full:example.com")).toBe("前缀请用 domain:");
    expect(reason("keyword:x")).toBe("前缀请用 domain_keyword:");
    expect(reason("foo:x")).toBe("不认识的前缀 foo:");
    expect(reason("https://www.Example.com/a?b")).toBe("只填域名，例如 www.example.com");
    expect(reason("example.com:443")).toContain("不支持端口");
    expect(reason("localhost:8080")).toContain("不支持端口");
    expect(reason("a b")).toContain("空格");
    expect(reason("ip_cidr:10.0.0.0/8")).toBe("这里只能填域名");
    expect(reason("10.0.0.1")).toBe("这里只能填域名");
    expect(reason("10.0.0.1", true)).toBeUndefined();
    expect(reason("fd00::/8", true)).toBeUndefined();
    expect(reason("300.1.1.1", true)).toBe("IP 地址或网段格式不正确");
    expect(reason("example.com/path", true)).toBe("只填域名，不要带路径");
  });

  it("puts the reasons in the validation message", () => {
    const p = blueprintProfile();
    p.settings.directDomains = ["ok.example", "*.a.example"];
    expect(validate(p).find((i) => i.message.includes("直连域名"))?.message).toBe(
      "直连域名或 IP 格式不正确：*.a.example（不支持通配符：只匹配子域名写 .a.example，连同它本身写 a.example）",
    );
  });

  it("takes IP prefixes into their own set, and leaves the config as it was without them", () => {
    const plain = withList(["example.com"]);
    expect(plain.route.rule_set.some((r: any) => r.tag === "custom-direct-ips")).toBe(false);
    expect(JSON.stringify(plain.route.rules)).toContain('{"rule_set":"custom-direct-domains"}');
    const cfg = withList(["example.com", "198.51.100.0/24", "2001:db8::1"]);
    expect(ruleSet(cfg).rules).toEqual([{ domain_suffix: ["example.com"] }]);
    expect(cfg.route.rule_set.find((r: any) => r.tag === "custom-direct-ips").rules).toEqual([{ ip_cidr: ["198.51.100.0/24", "2001:db8::1/128"] }]);
    expect(JSON.stringify(cfg.route.rules)).toContain('{"rule_set":["custom-direct-domains","custom-direct-ips"]}');
    // DNS goes by domain only.
    expect(JSON.stringify(cfg.dns.rules)).not.toContain("custom-direct-ips");
  });

  it("sends listed addresses direct in every mode but Global, ahead of the proxy list", () => {
    const p = blueprintProfile();
    p.settings.directDomains = ["203.0.113.0/24"];
    p.settings.proxyRules = ["203.0.113.0/24"];
    const at = (mode: Connection["mode"]) => routeWalk(gen(p), { mode, ip: "203.0.113.9" });
    expect(at("Non-CN")).toBe("route:direct");
    expect(at("GFWList")).toBe("route:direct");
    expect(at("Global")).toBe("route:proxy");
  });

  it("still refuses CN IPv6 listed as direct when there is no local IPv6, even if the proxy list has it too", () => {
    const p = blueprintProfile();
    p.settings.directDomains = ["240e::/20"];
    const at = (publicV6Iface: boolean) => routeWalk(gen(p), { mode: "Non-CN", ip: "240e:1::1", cn: true, publicV6Iface });
    expect(at(false)).toBe("reject");
    expect(at(true)).toBe("route:direct");
    // Also in the proxy list: the direct list wins in routing, so the address is still refused.
    p.settings.proxyRules = ["240e::/20", "2408::/16"];
    expect(at(false)).toBe("reject");
    expect(routeWalk(gen(p), { mode: "Non-CN", ip: "2408::1", cn: true, publicV6Iface: false })).toBe("route:proxy");
  });

  it("routes listed domains direct in every mode but Global", () => {
    const rules = withList(["example.com"]).route.rules;
    const idx = rules.findIndex((r: any) => JSON.stringify(r).includes("custom-direct-domains"));
    expect(rules[idx].outbound).toBe("direct");
    const gfwIdx = rules.findIndex((r: any) => JSON.stringify(r).includes('"GFWList"') && r.outbound === "direct");
    expect(idx).toBeLessThan(gfwIdx);
  });

  it("resolves listed domains locally, even when they are in gfwlist", () => {
    const rules = withList(["example.com"]).dns.rules;
    for (const mode of ["Direct", "GFWList", "Non-CN"] as const) {
      for (const qtype of ["A", "AAAA", "HTTPS"] as const) {
        expect(walk(rules, { mode, qtype, gfw: true, customDirect: true, publicV6Iface: true }), `${mode} ${qtype}`).toEqual({
          evaluated: [],
          final: "route:local",
        });
      }
    }
    expect(walk(rules, { mode: "Global", qtype: "A", customDirect: true }).evaluated).toEqual(["remote"]);
  });

  it("reports malformed entries", () => {
    const p = blueprintProfile();
    p.settings.directDomains = ["good.example", "bad domain", "http://x.com"];
    const msg = validate(p).find((i) => i.message.includes("直连域名"))?.message ?? "";
    expect(msg).toContain("bad domain");
    expect(msg).toContain("http://x.com");
  });
});

describe("custom proxy domains and IPs", () => {
  const withList = (lines: string[], extra: Partial<Profile["settings"]> = {}) => {
    const p = blueprintProfile();
    p.settings.proxyRules = lines;
    Object.assign(p.settings, extra);
    return gen(p);
  };
  const set = (cfg: any, tag: string) => cfg.route.rule_set.find((r: any) => r.tag === tag).rules;

  it("splits domains and IP prefixes into the two rule-sets", () => {
    const cfg = withList(["Intercom.io", "203.0.113.7", "2001:db8::/32", "10.0.0.0/8  # lab", "ip_cidr:192.0.2.0/24", "ip_cidr:x", "bad entry"]);
    expect(set(cfg, "gfwlist-custom-domains")).toEqual([{ domain_suffix: ["intercom.io"] }]);
    expect(set(cfg, "gfwlist-custom-ips")).toEqual([{ ip_cidr: ["203.0.113.7/32", "2001:db8::/32", "10.0.0.0/8", "192.0.2.0/24"] }]);
  });

  it("keeps placeholders and adds no rules when empty", () => {
    const cfg = withList(["", "  # nothing"]);
    expect(set(cfg, "gfwlist-custom-domains")).toEqual([{ domain_regex: ["a^"] }]);
    expect(cfg.route.rules.some(usesCustomList)).toBe(false);
  });

  it("routes listed entries through the proxy after the direct lists and before mode rules", () => {
    const rules = withList(["intercom.io"]).route.rules;
    const idx = rules.findIndex(usesCustomList);
    const directIdx = rules.findIndex((r: any) => JSON.stringify(r).includes("custom-direct-domains"));
    const modeIdx = rules.findIndex((r: any) => JSON.stringify(r).includes('"GFWList"') && r.outbound === "direct");
    expect(rules[idx]).toEqual({ rule_set: ["gfwlist-custom-domains", "gfwlist-custom-ips"], action: "route", outbound: "proxy" });
    expect(directIdx).toBeLessThan(idx);
    expect(idx).toBeLessThan(modeIdx);
  });

  it("resolves listed domains remotely and IPv4-only, except in Direct mode or when also listed as direct", () => {
    const rules = withList(["intercom.io"]).dns.rules;
    for (const mode of ["GFWList", "Non-CN", "Global"] as const) {
      // Even a domain on the domestic list is proxied once it is listed here.
      expect(walk(rules, { mode, qtype: "A", customProxy: true, cnSite: true }), mode).toEqual({ evaluated: [], final: "route:remote" });
      expect(walk(rules, { mode, qtype: "AAAA", customProxy: true, cnSite: true }).final, mode).toBe("predefined:NOERROR");
    }
    expect(walk(rules, { mode: "Direct", qtype: "A", customProxy: true })).toEqual({ evaluated: [], final: "route:local" });
    expect(walk(rules, { mode: "GFWList", qtype: "A", customProxy: true, customDirect: true })).toEqual({ evaluated: [], final: "route:local" });
  });

  it("parses IPv4, IPv6 and bare addresses", () => {
    expect(parseRuleList("1.2.3.4\n1.2.3.0/24\n::1\nfe80::/10\n300.1.1.1\n1.2.3.4/33")).toEqual({
      domains: { domain: [], domain_suffix: [], domain_keyword: [], domain_regex: [] },
      cidrs: ["1.2.3.4/32", "1.2.3.0/24", "::1/128", "fe80::/10"],
      invalid: [
        { entry: "300.1.1.1", reason: "IP 地址或网段格式不正确" },
        { entry: "1.2.3.4/33", reason: "IP 地址或网段格式不正确" },
      ],
    });
  });
});

describe("rules", () => {
  const setup = (lines: string[], outbound?: (p: Profile) => string) => {
    const p = blueprintProfile();
    p.settings.directDomains = ["direct.example"];
    p.settings.proxyRules = ["proxied.example"];
    p.settings.rules = [newRule({ outbound: outbound ? outbound(p) : p.nodes[1].id, lines })];
    return p;
  };

  it("sends matching traffic to the chosen node, after the direct list and before the proxy list", () => {
    const p = setup(["openai.com", "domain_keyword:claude", "192.0.2.0/24"]);
    const rules = gen(p).route.rules;
    const idx = rules.findIndex((r: any) => r.outbound === "reality-1");
    expect(rules[idx]).toEqual({ domain_suffix: ["openai.com"], domain_keyword: ["claude"], ip_cidr: ["192.0.2.0/24"], action: "route", outbound: "reality-1" });
    expect(rules.findIndex((r: any) => JSON.stringify(r).includes("custom-direct-domains"))).toBeLessThan(idx);
    expect(idx).toBeLessThan(rules.findIndex(usesCustomList));
    expect(rules.findIndex((r: any) => r.clash_mode === "Direct")).toBeLessThan(idx);
  });

  it("can send traffic to a group, and keeps rule order", () => {
    const p = setup(["a.example"]);
    const g = newGroup({ tag: "us", members: [p.nodes[0].id] });
    p.groups = [g];
    p.settings.rules.push(newRule({ outbound: g.id, lines: ["b.example"] }));
    const outs = gen(p).route.rules.filter((r: any) => r.action === "route").map((r: any) => r.outbound);
    expect(outs.indexOf("reality-1")).toBeLessThan(outs.indexOf("us"));
  });

  it("resolves rule domains remotely and IPv4-only, like the proxy list", () => {
    const dns = gen(setup(["openai.com"])).dns.rules;
    for (const mode of ["GFWList", "Non-CN", "Global"] as const) {
      expect(walk(dns, { mode, qtype: "A", ruleDomain: true, cnSite: true }), mode).toEqual({ evaluated: [], final: "route:remote" });
      expect(walk(dns, { mode, qtype: "AAAA", ruleDomain: true }).final, mode).toBe("predefined:NOERROR");
    }
    expect(walk(dns, { mode: "Direct", qtype: "A", ruleDomain: true })).toEqual({ evaluated: [], final: "route:local" });
    expect(walk(dns, { mode: "GFWList", qtype: "A", ruleDomain: true, customDirect: true }).final).toBe("route:local");
  });

  it("adds no DNS rule-set for IP-only rules", () => {
    const cfg = gen(setup(["192.0.2.0/24"]));
    expect(cfg.route.rule_set.some((r: any) => r.tag === "custom-rule-domains")).toBe(false);
  });

  it("leaves out rules with no exit, a deleted exit, an empty group or no entries, and says why", () => {
    const empty = newGroup({ tag: "empty" });
    const cases: [Profile, string][] = [
      [setup(["a.example"], () => ""), "还没有选择出口"],
      [setup(["a.example"], () => "gone"), "已删除"],
      [Object.assign(setup(["a.example"], () => empty.id), { groups: [empty] }), "还是空的"],
      [setup(["# nothing"]), "还没有填写域名或 IP"],
    ];
    for (const [p, msg] of cases) {
      const cfg = gen(p);
      expect(JSON.stringify(cfg.route.rules)).not.toContain("a.example");
      expect(cfg.route.rule_set.some((r: any) => r.tag === "custom-rule-domains")).toBe(false);
      expect(validate(p).find((i) => i.id === p.settings.rules[0].id)?.message).toContain(msg);
    }
  });

  it("can send traffic to an endpoint node such as WireGuard", () => {
    const p = blueprintProfile();
    const wg = newNode({ tag: "wg", body: filledBody("wireguard") });
    p.nodes.push(wg);
    p.settings.rules = [newRule({ outbound: wg.id, lines: ["10.30.0.0/16"] })];
    const cfg = gen(p);
    expect(cfg.endpoints.map((e: any) => e.tag)).toContain("wg");
    expect(cfg.route.rules).toContainEqual({ ip_cidr: ["10.30.0.0/16"], action: "route", outbound: "wg" });
  });

  it("comes after tailnet routes", () => {
    const p = setup(["nas.example.com"]);
    p.settings.tailnets = [newTailnet({ tag: "ts", routes: ["nas.example.com"] })];
    const outs = gen(p).route.rules.map((r: any) => r.outbound);
    expect(outs.indexOf("ts")).toBeLessThan(outs.indexOf("reality-1"));
  });

  it("is left out with a warning when the node's JSON is broken", () => {
    const p = setup(["a.example"]);
    p.nodes[1].body = "{ broken";
    expect(JSON.stringify(gen(p).route.rules)).not.toContain("a.example");
    expect(validate(p).find((i) => i.id === p.settings.rules[0].id)?.message).toBe("规则 1：节点「reality-1」的配置有错误，暂不写入配置");
  });

  it("reports malformed entries", () => {
    const p = setup(["ok.example", "bad entry"]);
    expect(validate(p).find((i) => i.id === p.settings.rules[0].id)?.message).toBe("规则 1：域名或 IP 格式不正确：bad entry（一行只写一项，中间不能有空格）");
  });
});

describe("rejecting direct CN IPv6 without local IPv6", () => {
  const cnV6: Omit<Connection, "mode"> = { ip: "240e:1::1", cn: true, publicV6Iface: false };
  const profile = (extra: Partial<Profile["settings"]> = {}, rule?: string[]) => {
    const p = blueprintProfile();
    Object.assign(p.settings, extra);
    if (rule) p.settings.rules = [newRule({ outbound: p.nodes[1].id, lines: rule })];
    return p;
  };
  const where = (p: Profile, mode: Connection["mode"], c: Omit<Connection, "mode"> = cnV6) => routeWalk(gen(p), { mode, ...c });

  it("rejects unlisted CN IPv6 in GFWList and Non-CN, so apps fall back to IPv4", () => {
    const p = profile();
    expect(where(p, "GFWList")).toBe("reject");
    expect(where(p, "Non-CN")).toBe("reject");
    expect(where(p, "Global")).toBe("route:proxy");
    expect(where(p, "Direct")).toBe("route:direct");
    expect(where(p, "Non-CN", { ...cnV6, publicV6Iface: true })).toBe("route:direct");
  });

  it("lets prefixes in a rule through to the rule's node in both modes", () => {
    const p = profile({}, ["240e::/20"]);
    expect(where(p, "GFWList")).toBe("route:reality-1");
    expect(where(p, "Non-CN")).toBe("route:reality-1");
    // Outside the listed prefix: still refused.
    expect(where(p, "Non-CN", { ...cnV6, ip: "240e:3000::1" })).toBe("reject");
    expect(gen(p).route.rule_set.find((r: any) => r.tag === "custom-rule-ips")).toEqual({
      type: "inline",
      tag: "custom-rule-ips",
      rules: [{ ip_cidr: ["240e::/20"] }],
    });
  });

  it("matches a rule's prefixes by address even when the rule also lists domains", () => {
    const p = profile({}, ["openai.com", "domain_keyword:claude", "2408::/16"]);
    expect(where(p, "Non-CN", { ...cnV6, ip: "2408:8000::1" })).toBe("route:reality-1");
    expect(where(p, "Global", { ip: "2408:8000::1" })).toBe("route:reality-1");
  });

  it("lets prefixes in the proxy list through to proxy, in Non-CN mode too", () => {
    const p = profile({ proxyRules: ["240e::/20"] });
    expect(where(p, "GFWList")).toBe("route:proxy");
    expect(where(p, "Non-CN")).toBe("route:proxy");
    expect(where(p, "Non-CN", { ...cnV6, ip: "240e:3000::1" })).toBe("reject");
  });

  it("leaves the rule as it was when no list has IP prefixes", () => {
    const plain = gen(profile({ proxyRules: ["example.com"] }, ["openai.com"]));
    expect(JSON.stringify(plain.route.rules[0])).not.toContain("custom-rule-ips");
    expect(JSON.stringify(plain.route.rules[0])).not.toContain('"gfwlist-custom-ips","invert"');
    expect(plain.route.rule_set.some((r: any) => r.tag === "custom-rule-ips")).toBe(false);
  });
});

describe("Tailscale", () => {
  const withTailnets = (...tailnets: ReturnType<typeof newTailnet>[]) => {
    const p = blueprintProfile();
    p.settings.tailnets = tailnets;
    return p;
  };

  it("fills in type and tag, ignoring any in the JSON", () => {
    const cfg = gen(withTailnets(newTailnet({ tag: "home", endpoint: '{"type":"x","tag":"y","hostname":"h"}' })));
    expect(cfg.endpoints).toEqual([{ type: "tailscale", tag: "home", hostname: "h" }]);
  });

  it("creates the DNS server only when MagicDNS or split DNS is used", () => {
    const none = gen(withTailnets(newTailnet({ tag: "a", magicDns: false })));
    expect(none.dns.servers.some((s: any) => s.type === "tailscale")).toBe(false);
    expect(JSON.stringify(none.dns.rules)).not.toContain("a-dns");
    const split = gen(withTailnets(newTailnet({ tag: "a", magicDns: false, dnsDomains: ["corp.example.com"] })));
    expect(split.dns.servers.find((s: any) => s.tag === "a-dns")).toEqual({ type: "tailscale", tag: "a-dns", endpoint: "a", accept_search_domain: true });
    expect(split.dns.rules[0]).toEqual({ domain_suffix: ["corp.example.com"], action: "route", server: "a-dns" });
    expect(JSON.stringify(split.dns.rules)).not.toContain('"preferred_by":"a-dns"');
  });

  it("takes match prefixes in split DNS and extra routes", () => {
    const cfg = gen(withTailnets(newTailnet({ tag: "a", magicDns: false, dnsDomains: ["domain_keyword:corp"], routes: ["domain:nas.lan", "10.0.0.0/8"] })));
    expect(cfg.dns.rules[0]).toEqual({ domain_keyword: ["corp"], action: "route", server: "a-dns" });
    expect(cfg.route.rules).toContainEqual({ domain: ["nas.lan"], ip_cidr: ["10.0.0.0/8"], action: "route", outbound: "a" });
  });

  it("routes tailnet devices and extra routes to the endpoint, and keeps them out of the IPv6 reject rule", () => {
    const cfg = gen(withTailnets(newTailnet({ tag: "a", routes: ["10.20.0.0/16", "nas.example.com"] })));
    expect(cfg.route.rules).toContainEqual({ preferred_by: "a", action: "route", outbound: "a" });
    expect(cfg.route.rules).toContainEqual({ domain_suffix: ["nas.example.com"], ip_cidr: ["10.20.0.0/16"], action: "route", outbound: "a" });
    expect(JSON.stringify(cfg.route.rules[0])).toContain('"preferred_by":["a"]');
  });

  it("offers the endpoint in the proxy selector only when asked", () => {
    const off = gen(withTailnets(newTailnet({ tag: "a" })));
    expect(off.outbounds[0].outbounds).not.toContain("a");
    const on = gen(withTailnets(newTailnet({ tag: "a", asProxy: true, endpoint: '{"exit_node":"x"}' })));
    expect(on.outbounds[0].outbounds).toContain("a");
    expect(on.outbounds.find((o: any) => o.tag === "auto").outbounds).not.toContain("a");
  });

  it("takes the exit node from its field only", () => {
    const endpoint = (t: Tailnet) => gen(withTailnets(t)).endpoints.find((e: any) => e.tag === "a");
    expect(endpoint(newTailnet({ tag: "a", exitNode: "gw" })).exit_node).toBe("gw");
    // One in the endpoint JSON is dropped and pointed out.
    const stale = newTailnet({ tag: "a", exitNode: "", endpoint: '{"exit_node":"old"}' });
    expect(endpoint(stale).exit_node).toBeUndefined();
    expect(validate(withTailnets(stale)).map((i) => i.detail)).toContain("端点 JSON 里的 exit_node 不会生效，请填在「出口节点」里");
    const ok = validate(withTailnets(newTailnet({ tag: "a", asProxy: true, exitNode: "gw" }))).map((i) => i.message);
    expect(ok.join("\n")).not.toContain("出口节点");
  });

  it("validates tags, JSON and state directories", () => {
    const p = withTailnets(
      newTailnet({ tag: "a" }),
      newTailnet({ tag: "a" }),
      newTailnet({ tag: "b", endpoint: "{ not json" }),
      newTailnet({ tag: "hy2-1" }),
      newTailnet({ tag: "c", asProxy: true, endpoint: '{"state_directory":"c"}' }),
    );
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain("标签重复：a");
    expect(msgs).toContain("标签重复：hy2-1");
    expect(msgs).toContain("JSON 有误");
    expect(msgs).toContain("state_directory「tailscale」");
    expect(msgs).toContain("没有填出口节点");
  });

  it("parses JSON with comments but keeps // inside strings", () => {
    expect(parseJsonc('{ // c\n "u": "https://x//y", /* block */ "n": 1 }')).toEqual({ u: "https://x//y", n: 1 });
  });
});

describe("platform and modes", () => {
  it("enables auto_redirect only on Linux", () => {
    for (const platform of ["apple", "android", "windows", "linux"] as const) {
      const p = blueprintProfile();
      p.settings.platform = platform;
      expect(!!gen(p).inbounds[0].auto_redirect, platform).toBe(platform === "linux");
    }
  });

  it("uses the configured default mode", () => {
    const p = blueprintProfile();
    p.settings.defaultMode = "Non-CN";
    expect(gen(p).experimental.clash_api.default_mode).toBe("Non-CN");
  });
});

describe("nodes", () => {
  const withNodes = (...nodes: ReturnType<typeof newNode>[]) => {
    const p = blueprintProfile();
    p.nodes = nodes;
    return p;
  };

  it("migrates v1 form servers into nodes with the same tags", () => {
    expect(personalProfile().nodes.map((n) => n.tag)).toEqual(["us-la-99-hy2", "us-la-99-vless", "us-la3-zgo-hy2", "us-la3-zgo-vless"]);
  });

  it("every template is a known type and produces a node without errors once filled in", () => {
    const ids = new Set<string>();
    for (const t of TEMPLATES) {
      ids.add(t.id);
      const { object, error } = nodeObject(newNode({ tag: "x", body: t.body }));
      expect(error, t.id).toBeUndefined();
      expect(NODE_TYPES, t.id).toContain(object!.type);
      const errors = validate(withNodes(newNode({ tag: "x", body: t.body }))).filter((i) => i.level === "error");
      expect(errors, t.id).toEqual([]);
    }
    expect(ids.size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => JSON.stringify(nodeObject(newNode({ body: t.body })).object!.type)))).toEqual(
      new Set(NODE_TYPES.map((t) => JSON.stringify(t))),
    );
  });

  it("puts endpoint types under endpoints and the rest under outbounds", () => {
    const wg = TEMPLATES.find((t) => t.id === "wireguard")!;
    const cfg = gen(withNodes(newNode({ tag: "hy" }), newNode({ tag: "wg", body: wg.body })));
    expect(cfg.endpoints.map((e: any) => e.tag)).toEqual(["wg"]);
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual(["proxy", "auto", "hy", "direct"]);
    expect(cfg.outbounds[1].outbounds).toEqual(["hy", "wg"]);
  });

  it("fills in tag and the local domain resolver unless set", () => {
    const cfg = gen(
      withNodes(
        newNode({ tag: "a", body: '{"type":"trojan","tag":"ignored","server":"s.example.org","server_port":443,"password":"p"}' }),
        newNode({ tag: "b", body: '{"type":"trojan","server":"s.example.org","server_port":443,"password":"p","domain_resolver":"remote"}' }),
      ),
    );
    expect(cfg.outbounds[2]).toEqual({ type: "trojan", tag: "a", server: "s.example.org", server_port: 443, password: "p", domain_resolver: "local" });
    expect(cfg.outbounds[3].domain_resolver).toBe("remote");
  });

  it("leaves nodes out of the groups when asked", () => {
    const cfg = gen(withNodes(newNode({ tag: "a" }), newNode({ tag: "helper", inGroups: false })));
    expect(cfg.outbounds[0].outbounds).toEqual(["auto", "a"]);
    expect(cfg.outbounds[1].outbounds).toEqual(["a"]);
    expect(cfg.outbounds.map((o: any) => o.tag)).toContain("helper");
  });

  it("validates JSON, type, server, detour and empty secrets", () => {
    const msgs = validate(
      withNodes(
        newNode({ tag: "bad", body: "{ nope" }),
        newNode({ tag: "unknown", body: '{"type":"vless2"}' }),
        newNode({ tag: "noserver", body: '{"type":"trojan","password":"p"}' }),
        newNode({ tag: "detour", body: '{"type":"shadowsocks","server":"s.example.org","method":"none","password":"p","detour":"nowhere"}' }),
        newNode({ tag: "empty", body: '{"type":"trojan","server":"s.example.org","password":""}' }),
      ),
    )
      .map((i) => i.message)
      .join("\n");
    expect(msgs).toContain("节点「bad」：JSON 有误");
    expect(msgs).toContain("节点「unknown」：type 必须是");
    expect(msgs).toContain("节点「noserver」：缺少 server");
    expect(msgs).toContain("「nowhere」不存在");
    expect(msgs).toContain("节点「empty」：password 为空");
    const reality = TEMPLATES.find((t) => t.id === "vless-reality")!;
    const nested = validate(withNodes(newNode({ tag: "r", body: reality.body }))).map((i) => i.message);
    expect(nested).toContain("节点「r」：tls.reality.public_key 为空，sing-box 可能无法加载");
  });

  it("checks Shadowsocks 2022 keys like sing-box does", () => {
    const ss = (method: string, password: string) =>
      validate(withNodes(newNode({ tag: "ss", body: JSON.stringify({ type: "shadowsocks", server: "s.example.org", server_port: 1, method, password }) })))
        .filter((i) => i.message.includes("base64 密钥"))
        .map((i) => i.message);
    expect(ss("2022-blake3-aes-128-gcm", "dummy-pass")).toHaveLength(1);
    expect(ss("2022-blake3-aes-128-gcm", "UPFTpZE0Gb2XVeTW9VNioQ==")).toEqual([]);
    expect(ss("2022-blake3-aes-256-gcm", "UPFTpZE0Gb2XVeTW9VNioQ==")).toHaveLength(1);
    expect(ss("2022-blake3-chacha20-poly1305", "fuQQqj0+RRUmmQ/to1EvkWkzyEU7m4ZS40+qiz2zmfQ=")).toEqual([]);
    expect(ss("2022-blake3-aes-128-gcm", "UPFTpZE0Gb2XVeTW9VNioQ==:UPFTpZE0Gb2XVeTW9VNioQ==")).toEqual([]);
    expect(ss("aes-128-gcm", "anything")).toEqual([]);
  });

  it("requires at least one node in the groups", () => {
    const msgs = validate(withNodes(newNode({ tag: "a", inGroups: false }))).map((i) => i.message);
    expect(msgs).toContain("至少要有一个节点加入代理组");
  });
});

describe("validate", () => {
  it("flags duplicate tags, including clashes with reserved ones", () => {
    const p = blueprintProfile();
    p.nodes[1].tag = p.nodes[0].tag;
    p.nodes.push(newNode({ tag: "direct" }));
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain(`标签重复：${p.nodes[0].tag}`);
    expect(msgs).toContain("标签 direct 是生成器自己用的，请换一个");
  });

  it("flags a malformed ECS subnet and proxy list entries", () => {
    const p = blueprintProfile();
    p.settings.clientSubnet = "hangzhou";
    p.settings.proxyRules = ["bad entry"];
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain("ECS");
    expect(msgs).toContain("代理域名或 IP");
  });
});

describe("JSONC", () => {
  it("blanks comments without moving anything", () => {
    for (const text of ['{"a": 1 // note\n}', '{/* x */"a": "//not a comment"}', '{"a": 1} /* unclosed', "// only\n{}"]) {
      const stripped = stripComments(text);
      expect(stripped).toHaveLength(text.length);
      expect(stripped.split("\n").length).toBe(text.split("\n").length);
      expect(() => JSON.parse(stripped)).not.toThrow();
    }
    expect(parseJsonc('{/* x */"a": "//not a comment"}')).toEqual({ a: "//not a comment" });
  });

  it("locates parse errors in the original text", () => {
    const text = '{\n  // trailing comma\n  "a": 1,\n}';
    const stripped = stripComments(text);
    let message = "";
    try {
      JSON.parse(stripped);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(text.slice(jsonErrorOffset(message, stripped)!)).toBe("}");
    // Engines that report line and column instead of an offset.
    expect(jsonErrorOffset("Unexpected token at line 4 column 1", text)).toBe(text.length - 1);
    expect(jsonErrorOffset("JSON Parse error: Unexpected EOF", text)).toBeNull();
  });
});
