// Sample profiles covering every node template and feature/platform combination.
// Template placeholders are filled with well-formed values so checks exercise field structure.
// Shared by the schema test and scripts/gen-check-configs.ts (`sing-box check`).
import { readFileSync } from "node:fs";
import { parseJsonc } from "../src/generate";
import { fitImport, importConfig } from "../src/importer";
import { blueprintProfile, newDnsRule, newGroup, newNode, newRule, newTailnet } from "../src/defaults";
import { TEMPLATES } from "../src/templates";
import type { Profile } from "../src/types";
import { LINKS, b64 } from "./subscription-links";

const DUMMY: Record<string, string> = {
  password: "dummy-pass",
  uuid: "bf000d23-0752-40b4-affe-68f7707a9661",
  psk: "dummy-psk",
  auth_str: "dummy",
  username: "user",
  private_key: "YNXtAzepDqRv9H52osJVDQnznT5AM11eCK3ESpwSt04=",
  short_id: "0123456789abcdef",
};

function fill(v: any, key = "", parent = ""): any {
  if (Array.isArray(v)) return v.map((x) => fill(x, key, parent));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, k, key)]));
  if (v !== "") return v;
  if (key === "public_key") {
    return parent === "reality" ? "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0" : "Z1XXLsKYkYxuiYjJIkRvtIKFepCYHTgON+GwPq7SOV4=";
  }
  return DUMMY[key] ?? v;
}

/** A template body with placeholders filled. Shadowsocks 2022 needs a base64 key of the cipher's size. */
export function filledBody(templateId: string, extra: object = {}): string {
  const o = fill(parseJsonc(TEMPLATES.find((t) => t.id === templateId)!.body));
  if (o.type === "shadowsocks" && String(o.method).startsWith("2022-")) {
    o.password = String(o.method).includes("128") ? "UPFTpZE0Gb2XVeTW9VNioQ==" : "fuQQqj0+RRUmmQ/to1EvkWkzyEU7m4ZS40+qiz2zmfQ=";
  }
  return JSON.stringify({ ...o, ...extra });
}

/** Everything switched on: all templates (but Tor), two tailnets, both lists, ECS, optional rules. */
function fullProfile(): Profile {
  const p = blueprintProfile();
  p.nodes = TEMPLATES.filter((t) => t.id !== "tor").map((t, i) => newNode({ tag: `${t.tagPrefix}-${i}`, body: filledBody(t.id) }));
  Object.assign(p.settings, {
    steam: true,
    blockIcloudQuic: true,
    clientSubnet: "203.0.113.0/24",
    clashSecret: "s",
    directDomains: ["example.cn", "domain:www.example.org", "domain_keyword:intranet", ".example.org", "198.51.100.0/24", "2001:db8:1::/48"],
    proxyRules: ["intercom.io", "203.0.113.0/24", "2001:db8::/32", "domain_regex:^cdn\\d+\\.example\\.net$", "ip_cidr:198.51.100.0/24"],
    tailnets: [
      newTailnet({ tag: "home", endpoint: '{"state_directory":"ts-home","hostname":"a","accept_routes":true}' }),
      newTailnet({
        tag: "work",
        endpoint: '{"state_directory":"ts-work","hostname":"b","accept_routes":true}',
        exitNode: "gw",
        acceptDefaultResolvers: true,
        routes: ["10.20.0.0/16", "nas.example.com", "domain:nas.lan"],
        asProxy: true,
      }),
    ],
  });
  // Groups: a hand-picked selector, and a url-test that nests it, used as proxy's default.
  const [a, b, c, d] = p.nodes;
  const pick = newGroup({ tag: "pick", type: "selector", members: [a.id, b.id, p.settings.tailnets[1].id], defaultMember: b.id });
  const fast = newGroup({ tag: "fast", type: "urltest", members: [c.id, d.id, pick.id], interval: "5m", tolerance: 100 });
  p.groups = [pick, fast];
  p.settings.proxyDefault = fast.id;
  p.settings.listNodesInProxy = false;
  p.settings.rules = [
    newRule({ outbound: fast.id, lines: ["openai.com", "domain_keyword:claude", "192.0.2.0/24"] }),
    newRule({ outbound: c.id, lines: ["domain:api.example.net"] }),
  ];
  p.settings.dnsRules = [
    newDnsRule({ server: "tailnet", tailnet: p.settings.tailnets[1].id, lines: ["corp.example.com", "domain_keyword:corp"] }),
    newDnsRule({ lines: ["corp.example.org", "domain_keyword:intra"] }),
    newDnsRule({ server: "remote", lines: ["domain:api.example.org"] }),
    newDnsRule({ custom: '{"type":"udp","server":"192.168.1.1"}', lines: [".", "lan", "home.arpa"] }),
    newDnsRule({
      custom: '{"type":"https","server":"1.1.1.1","path":"/dns-query","tls":{"enabled":true,"server_name":"cloudflare-dns.com"},"detour":"proxy"}',
      lines: ["domain_regex:^cdn\\d+\\.example\\.com$"],
    }),
  ];
  return p;
}

export function sampleProfiles(): { name: string; profile: Profile }[] {
  const samples: { name: string; profile: Profile }[] = [{ name: "default", profile: blueprintProfile() }];
  for (const t of TEMPLATES) {
    const p = blueprintProfile();
    p.nodes = [newNode({ tag: t.tagPrefix, body: filledBody(t.id) })];
    samples.push({ name: `tpl-${t.id}`, profile: p });
  }
  {
    // ShadowTLS is meant to be chained: Shadowsocks with detour to it.
    const p = blueprintProfile();
    p.nodes = [
      newNode({ tag: "st", body: filledBody("shadowtls"), inGroups: false }),
      newNode({ tag: "ss", body: filledBody("shadowsocks", { detour: "st" }) }),
    ];
    samples.push({ name: "combo-ss-shadowtls", profile: p });
  }
  for (const platform of ["apple", "android", "windows", "linux"] as const) {
    const p = fullProfile();
    p.settings.platform = platform;
    samples.push({ name: `full-${platform}`, profile: p });
  }
  for (const provider of ["google", "cloudflare", "quad9"] as const) {
    for (const protocol of ["tls", "https"] as const) {
      const p = blueprintProfile();
      p.nodes = [newNode({ tag: "hy2", body: filledBody("hysteria2") })];
      p.settings.remoteDns = { provider, protocol };
      samples.push({ name: `dns-${provider}-${protocol}`, profile: p });
    }
  }
  {
    // Rules to an endpoint node (WireGuard), a plain node and a group, with RE2-only regex syntax.
    const p = blueprintProfile();
    const wg = newNode({ tag: "wg", body: filledBody("wireguard") });
    const hy2 = newNode({ tag: "hy2", body: filledBody("hysteria2") });
    const g = newGroup({ tag: "pick", members: [hy2.id, wg.id] });
    p.nodes = [hy2, wg];
    p.groups = [g];
    p.settings.directDomains = [".direct.example", "domain_regex:(?i)^LAN\\d+\\."];
    p.settings.rules = [
      newRule({ outbound: wg.id, lines: ["corp.example", "10.30.0.0/16", "fd00:30::/32"] }),
      newRule({ outbound: hy2.id, lines: ["domain_regex:^(?P<host>[a-z]+)\\.cdn\\.example$", "domain_regex:^\\pL+\\.example$", "domain_keyword:tracker"] }),
      newRule({ outbound: g.id, lines: ["domain:api.example", ".sub.example"] }),
    ];
    samples.push({ name: "rules-edge", profile: p });
  }
  {
    const p = blueprintProfile();
    p.nodes = [newNode({ tag: "hy2", body: filledBody("hysteria2") })];
    p.settings.remoteDns = { ...p.settings.remoteDns, provider: "custom" }; // the default custom template
    samples.push({ name: "dns-custom", profile: p });
  }
  {
    // Everything the Clash importer maps, as it comes out of an import.
    const { nodes, groups } = fitImport(importConfig(readFileSync(new URL("./fixtures/clash-mihomo.yaml", import.meta.url), "utf8")));
    samples.push({ name: "clash-import", profile: { ...blueprintProfile(), nodes, groups } });
  }
  {
    // Every kind of share link, as a base64 subscription delivers them.
    const { nodes, groups } = fitImport(importConfig(b64(LINKS.join("\r\n"))));
    samples.push({ name: "subscription-import", profile: { ...blueprintProfile(), nodes, groups } });
  }
  return samples;
}
