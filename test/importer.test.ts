import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateConfig, validate as issues } from "../src/generate";
import Ajv2020 from "ajv/dist/2020";
import { fitImport, importSingBoxConfig } from "../src/importer";
import { normalize } from "./normalize";
import { sampleProfiles } from "./samples";

const baselineText = readFileSync(new URL("./fixtures/tiger-baseline.json", import.meta.url), "utf8");
const sample = (name: string) => sampleProfiles().find((s) => s.name === name)!.profile;
const schema = JSON.parse(readFileSync(new URL("./fixtures/sing-box-1.14.3.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

describe("importing an existing sing-box config", () => {
  const { nodes, tailnets, notes } = importSingBoxConfig(baselineText);

  it("takes the proxy nodes, in order, and keeps them in the groups they were in", () => {
    expect(nodes.map((n) => n.tag)).toEqual(["us-la-99-hy2", "us-la-99-vless", "us-la3-zgo-hy2", "us-la3-zgo-vless"]);
    expect(nodes.every((n) => n.inGroups)).toBe(true);
  });

  it("drops resolvers that will not exist and SFM's server_port 0", () => {
    const hy2 = JSON.parse(nodes[0].body);
    expect(hy2.domain_resolver).toBeUndefined();
    expect(hy2.server_port).toBeUndefined();
    expect(hy2.server_ports).toBe("20000:50000");
    expect(notes.join()).toContain("cn-dns");
  });

  it("takes the tailnets with their DNS and routing options", () => {
    expect(tailnets.map((t) => t.tag)).toEqual(["home", "work"]);
    const [home, work] = tailnets;
    expect(home.magicDns && work.magicDns).toBe(true);
    expect(home.acceptDefaultResolvers).toBe(false);
    expect(work.acceptDefaultResolvers).toBe(true);
    expect(work.dnsDomains).toEqual(["corp.example.com"]);
    expect(JSON.parse(work.endpoint)).toMatchObject({ hostname: "my-mac-2", accept_routes: true });
    expect(JSON.parse(work.endpoint).type).toBeUndefined();
    // The exit node moves into its own field; no group offers the endpoint, so it stays out of proxy.
    expect(JSON.parse(work.endpoint).exit_node).toBeUndefined();
    expect(work.exitNode).toBe("office-gw");
    expect(work.asProxy).toBe(false);
    expect(home.asProxy).toBe(false);
  });

  it("makes a tailnet a proxy choice only when a selector offers it", () => {
    const config = JSON.parse(baselineText);
    config.outbounds.find((o: any) => o.tag === "proxy").outbounds.push("work");
    const [home, work] = importSingBoxConfig(JSON.stringify(config)).tailnets;
    expect(work.asProxy).toBe(true);
    expect(work.exitNode).toBe("office-gw");
    expect(home.asProxy).toBe(false);
  });

  it.each(["full-apple", "combo-ss-shadowtls"])("round-trips nodes, groups and Tailscale through a generated config (%s)", (name) => {
    const profile = sample(name);
    const config = generateConfig(profile) as any;
    const imported = importSingBoxConfig(JSON.stringify(config));
    // proxy's default, node listing and rules are settings of ours, not imported: map them across by tag.
    const tagOf = (id: string) => [...profile.groups, ...profile.nodes].find((x) => x.id === id)?.tag;
    const idOf = (tag: string | undefined) => [...imported.groups, ...imported.nodes].find((x) => x.tag === tag)?.id;
    const proxyDefault = idOf(tagOf(profile.settings.proxyDefault)) ?? "auto";
    const rules = profile.settings.rules.map((r) => ({ ...r, outbound: idOf(tagOf(r.outbound)) ?? "" }));
    const rebuilt = generateConfig({
      ...profile,
      nodes: imported.nodes,
      groups: imported.groups,
      settings: { ...profile.settings, tailnets: imported.tailnets, proxyDefault, rules },
    }) as any;
    expect(normalize(rebuilt.outbounds)).toEqual(normalize(config.outbounds));
    expect(normalize(rebuilt.endpoints)).toEqual(normalize(config.endpoints));
    expect(normalize(rebuilt.dns)).toEqual(normalize(config.dns));
    expect(normalize(rebuilt.route.rules)).toEqual(normalize(config.route.rules));
    expect(imported.notes).toEqual([]);
  });

  it("explains what it cannot use", () => {
    expect(() => importSingBoxConfig("{ nope")).toThrow("不是有效的 JSON");
    expect(() => importSingBoxConfig("[]")).toThrow("顶层必须是对象");
    expect(() => importSingBoxConfig('{"log":{}}')).toThrow("没有找到 outbounds");
    expect(() => importSingBoxConfig('{"outbounds":[{"type":"direct","tag":"d"}]}')).toThrow("没有可导入");
    const r = importSingBoxConfig('{"outbounds":[{"type":"trojan","tag":"t","server":"a.example.org","server_port":443,"password":"p"},{"type":"shadowsocksr","tag":"old"}]}');
    expect(r.nodes.map((n) => n.tag)).toEqual(["t"]);
    expect(r.notes.join()).toContain("old（shadowsocksr）");
  });

  it("accepts comments in the file", () => {
    const r = importSingBoxConfig('{ // exported\n "outbounds": [{"type":"socks","tag":"s","server":"127.0.0.1","server_port":1080}] }');
    expect(r.nodes[0].tag).toBe("s");
  });
});

describe("importing proxy groups", () => {
  const config = {
    outbounds: [
      { type: "selector", tag: "proxy", outbounds: ["auto", "hk", "a"] },
      { type: "urltest", tag: "auto", outbounds: ["a", "b"] },
      { type: "selector", tag: "hk", outbounds: ["a", "b", "direct"], default: "b" },
      { type: "urltest", tag: "fast", outbounds: ["hk", "c"], interval: "3m", tolerance: 80 },
      { type: "urltest", tag: "empty", outbounds: ["direct"] },
      // SFM re-saves durations the way Go prints them.
      { type: "urltest", tag: "go-default", outbounds: ["a"], interval: "3m0s" },
      { type: "urltest", tag: "go-long", outbounds: ["a"], interval: "1h30m0s" },
      { type: "urltest", tag: "odd", outbounds: ["a"], interval: "1.5ms" },
      { type: "trojan", tag: "a", server: "a.example.org", server_port: 443, password: "p" },
      { type: "trojan", tag: "b", server: "b.example.org", server_port: 443, password: "p" },
      { type: "trojan", tag: "c", server: "c.example.org", server_port: 443, password: "p" },
      { type: "direct", tag: "direct" },
    ],
  };
  const r = importSingBoxConfig(JSON.stringify(config));
  const id = (tag: string) => [...r.nodes, ...r.groups].find((x) => x.tag === tag)!.id;

  it("imports user groups with members by id, skipping proxy and auto", () => {
    expect(r.groups.map((g) => g.tag)).toEqual(["hk", "fast", "go-default", "go-long", "odd"]);
    expect(r.groups[0]).toMatchObject({ type: "selector", members: [id("a"), id("b")], defaultMember: id("b") });
    expect(r.groups[1]).toMatchObject({ type: "urltest", members: [id("hk"), id("c")], interval: "", tolerance: 80 });
  });

  it("rewrites Go-style intervals in the form the editor takes", () => {
    expect(r.groups.slice(2).map((g) => g.interval)).toEqual(["", "90m", "1.5ms"]);
  });

  it("takes direct offering from proxy/auto, and explains what was dropped", () => {
    expect(r.nodes.map((n) => [n.tag, n.inGroups])).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
    expect(r.notes.join()).toContain("「empty」没有可导入的成员");
    expect(r.notes.join()).toContain("direct");
  });
});

describe("legacy WireGuard outbounds", () => {
  const r = importSingBoxConfig(
    JSON.stringify({
      outbounds: [
        { type: "trojan", tag: "t", server: "t.example.org", server_port: 443, password: "p" },
        {
          type: "wireguard",
          tag: "wg",
          server: "203.0.113.1",
          server_port: 51820,
          local_address: ["10.0.0.2/32"],
          private_key: "cHJpdmF0ZQ==",
          peer_public_key: "cHVibGlj",
          reserved: [1, 2, 3],
          mtu: 1408,
          gso: true,
        },
        {
          type: "wireguard",
          tag: "wg-multi",
          system_interface: true,
          interface_name: "wg0",
          local_address: "10.1.0.2/32",
          private_key: "cHJpdmF0ZQ==",
          peers: [{ server: "198.51.100.1", server_port: 51820, public_key: "cGVlcg==", allowed_ips: ["10.1.0.0/24"] }],
        },
      ],
    }),
  );

  it("are rewritten as endpoints, in place, with a note", () => {
    expect(r.nodes.map((n) => n.tag)).toEqual(["t", "wg", "wg-multi"]);
    expect(JSON.parse(r.nodes[1].body)).toEqual({
      type: "wireguard",
      address: ["10.0.0.2/32"],
      private_key: "cHJpdmF0ZQ==",
      mtu: 1408,
      peers: [{ address: "203.0.113.1", port: 51820, public_key: "cHVibGlj", allowed_ips: ["0.0.0.0/0", "::/0"], reserved: [1, 2, 3] }],
    });
    expect(JSON.parse(r.nodes[2].body)).toMatchObject({
      system: true,
      name: "wg0",
      address: "10.1.0.2/32",
      peers: [{ address: "198.51.100.1", port: 51820, public_key: "cGVlcg==", allowed_ips: ["10.1.0.0/24"] }],
    });
    expect(r.notes.join()).toContain("旧版 WireGuard outbound（wg、wg-multi）");
  });

  it("generate a config that matches the 1.14 schema", () => {
    const profile = sample("full-apple");
    const config = generateConfig({ ...profile, nodes: r.nodes, groups: [] }) as any;
    expect(config.endpoints.filter((e: any) => e.type === "wireguard").map((e: any) => e.tag)).toEqual(["wg", "wg-multi"]);
    validate(config);
    expect(validate.errors ?? []).toEqual([]);
  });
});

describe("fitting an import into a profile", () => {
  const r = importSingBoxConfig(
    JSON.stringify({
      outbounds: [
        { type: "selector", tag: "hk", outbounds: ["a", "auto"] },
        { type: "shadowsocks", tag: "a", server: "a.example.org", server_port: 443, method: "aes-128-gcm", password: "p", detour: "auto" },
        { type: "shadowtls", tag: "auto", server: "b.example.org", server_port: 443, version: 3, password: "p" },
        { type: "trojan", tag: "direct", server: "c.example.org", server_port: 443, password: "p" },
      ],
      endpoints: [{ type: "tailscale", tag: "proxy", detour: "auto" }],
    }),
  );
  const fitted = fitImport(r);

  it("renames tags the generator uses itself", () => {
    expect(fitted.nodes.map((n) => n.tag)).toEqual(["a", "auto-2", "direct-2"]);
    expect(fitted.tailnets.map((t) => t.tag)).toEqual(["proxy-2"]);
    expect(fitted.groups.map((g) => g.tag)).toEqual(["hk"]);
    expect(fitted.renamed).toEqual(["auto → auto-2", "direct → direct-2", "proxy → proxy-2"]);
    // Members are by id, so the group keeps its nodes through the renames.
    expect(fitted.groups[0].members).toEqual(r.nodes.slice(0, 2).map((n) => n.id));
  });

  it("points detours at the renamed nodes", () => {
    expect(JSON.parse(fitted.nodes[0].body).detour).toBe("auto-2");
    expect(JSON.parse(fitted.tailnets[0].endpoint).detour).toBe("auto-2");
  });

  it("makes a profile without errors", () => {
    const base = sample("full-apple");
    const profile = { ...base, nodes: fitted.nodes, groups: fitted.groups, settings: { ...base.settings, tailnets: fitted.tailnets } };
    expect(issues(profile).filter((i) => i.level === "error")).toEqual([]);
    expect(validate(generateConfig(profile))).toBe(true);
  });

  it("leaves everything as it was without clashes", () => {
    const clean = importSingBoxConfig(JSON.stringify({ outbounds: [{ type: "socks", tag: "s", server: "127.0.0.1", server_port: 1080 }] }));
    const fitted = fitImport(clean);
    expect(fitted.nodes).toEqual(clean.nodes);
    expect(fitted.renamed).toEqual([]);
  });
});
