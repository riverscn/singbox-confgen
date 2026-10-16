import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { generateConfig, validate as issues } from "../src/generate";
import { importClashConfig } from "../src/clash";
import { fitImport, importConfig } from "../src/importer";
import { sampleProfiles } from "./samples";

const yamlText = readFileSync(new URL("./fixtures/clash-mihomo.yaml", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("./fixtures/sing-box-1.14.3.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const base = sampleProfiles().find((s) => s.name === "full-apple")!.profile;

describe("importing a Clash (mihomo) config", () => {
  const r = importConfig(yamlText);
  const body = (tag: string) => JSON.parse(r.nodes.find((n) => n.tag === tag)!.body);
  const tagOf = (id: string) => [...r.nodes, ...r.groups].find((x) => x.id === id)!.tag;

  it("is told apart from a sing-box config by its content", () => {
    expect(r.nodes.length).toBeGreaterThan(10);
    expect(r.tailnets).toEqual([]);
    // The same structure written as JSON is still a Clash config.
    const json = importConfig(JSON.stringify({ proxies: [{ name: "a", type: "trojan", server: "a.example.org", port: 443, password: "p" }] }));
    expect(json.nodes.map((n) => n.tag)).toEqual(["a"]);
  });

  it("keeps the names as tags, emoji and all, in file order", () => {
    expect(r.nodes.slice(0, 3).map((n) => n.tag)).toEqual(["🇭🇰 香港 01", "🇭🇰 香港 02 obfs", "🇯🇵 日本 ShadowTLS"]);
  });

  it("maps Shadowsocks with UoT and plugins", () => {
    expect(body("🇭🇰 香港 01")).toEqual({
      type: "shadowsocks",
      server: "hk1.example.org",
      server_port: 8388,
      method: "2022-blake3-aes-128-gcm",
      password: "AAAAAAAAAAAAAAAAAAAAAA==",
      udp_over_tcp: { enabled: true, version: 2 },
    });
    expect(body("🇭🇰 香港 02 obfs")).toMatchObject({ plugin: "obfs-local", plugin_opts: "obfs=tls;obfs-host=bing.com" });
  });

  it("splits the shadow-tls plugin into a ShadowTLS helper the node detours through", () => {
    const ss = body("🇯🇵 日本 ShadowTLS");
    expect(ss.detour).toBe("🇯🇵 日本 ShadowTLS-shadowtls");
    expect(body("🇯🇵 日本 ShadowTLS-shadowtls")).toEqual({
      type: "shadowtls",
      server: "jp1.example.org",
      server_port: 443,
      version: 3,
      password: "stpass",
      tls: { enabled: true, server_name: "www.apple.com", utls: { enabled: true, fingerprint: "chrome" } },
    });
    expect(r.nodes.find((n) => n.tag === "🇯🇵 日本 ShadowTLS-shadowtls")!.inGroups).toBe(false);
  });

  it("maps TLS, Reality and the V2Ray transports, through YAML merge keys", () => {
    expect(body("🇯🇵 日本 VMess WS")).toMatchObject({
      tls: { enabled: true, server_name: "jp2.example.org", utls: { enabled: true, fingerprint: "chrome" } },
      // Xray's ?ed= in the path is early data.
      transport: { type: "ws", path: "/ray", headers: { Host: "jp2.example.org" }, max_early_data: 2048, early_data_header_name: "Sec-WebSocket-Protocol" },
    });
    expect(body("🇯🇵 日本 VMess WS").security).toBeUndefined();
    expect(body("🇺🇸 美国 Reality")).toMatchObject({
      flow: "xtls-rprx-vision",
      tls: { server_name: "www.microsoft.com", reality: { enabled: true, short_id: "0123abcd" } },
    });
    expect(body("🇺🇸 美国 gRPC").transport).toEqual({ type: "grpc", service_name: "svc" });
    expect(body("🇬🇧 英国 HTTPUpgrade")).toMatchObject({
      security: "aes-128-gcm",
      transport: { type: "httpupgrade", path: "/up", host: "cdn.example.org" },
    });
    expect(body("🇸🇬 新加坡 Trojan")).toMatchObject({
      tls: { alpn: ["h2", "http/1.1"] },
      multiplex: { enabled: true, protocol: "h2mux", max_connections: 4 },
    });
  });

  it("maps the QUIC protocols' ports, bandwidth and options", () => {
    expect(body("🇸🇬 新加坡 Hy2")).toMatchObject({
      server_ports: ["20000:50000"],
      hop_interval: "30s",
      up_mbps: 50,
      down_mbps: 300,
      obfs: { type: "salamander", password: "o" },
    });
    expect(body("🇹🇼 台湾 TUIC")).toMatchObject({
      congestion_control: "bbr",
      zero_rtt_handshake: true,
      heartbeat: "10s",
      tls: { enabled: true, alpn: ["h3"] },
    });
    expect(body("🇰🇷 韩国 Hysteria")).toMatchObject({ auth_str: "a", up_mbps: 30, down_mbps: 200 });
    expect(body("🇹🇼 台湾 AnyTLS")).toMatchObject({ idle_session_timeout: "30s" });
  });

  it("maps WireGuard to an endpoint and the plain protocols", () => {
    expect(body("家里 WireGuard")).toEqual({
      type: "wireguard",
      address: ["10.0.0.2/32", "fd00::2/128"],
      private_key: "YNXtAzepDqRv9H52osJVDQnznT5AM11eCK3ESpwSt04=",
      mtu: 1408,
      peers: [
        {
          address: "203.0.113.1",
          port: 51820,
          public_key: "Z1XXLsKYkYxuiYjJIkRvtIKFepCYHTgON+GwPq7SOV4=",
          allowed_ips: ["0.0.0.0/0", "::/0"],
          reserved: [1, 2, 3],
        },
      ],
    });
    expect(body("跳板 SOCKS")).toMatchObject({ type: "socks", version: "5", network: "tcp" });
    expect(body("🇰🇷 韩国 Snell")).toMatchObject({ version: 4, obfs_mode: "http", obfs_host: "bing.com" });
    expect(body("机房 SSH")).toMatchObject({ user: "root", password: "p", host_key: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE/TmZBaitXAII0KSvBufEZFKnpLV6le1lwxA/1Wrl8l"] });
    // mihomo's private-key is the key itself or a path to it.
    const ssh = (key: string) =>
      JSON.parse(importClashConfig({ proxies: [{ name: "s", type: "ssh", server: "h", port: 22, "private-key": key }] }).nodes[0].body);
    expect(ssh("~/.ssh/id_ed25519")).toMatchObject({ private_key_path: "~/.ssh/id_ed25519" });
    expect(ssh("-----BEGIN OPENSSH PRIVATE KEY-----\nx").private_key).toContain("PRIVATE KEY");
  });

  it("turns dialer-proxy into a detour when it names a node, and drops it otherwise", () => {
    expect(body("落地 HTTP").detour).toBe("跳板 SOCKS");
    expect(body("经组出去").detour).toBeUndefined();
    expect(r.notes.join()).toContain("经组出去 → 🚀 节点选择");
  });

  it("skips what sing-box can't express, saying why", () => {
    const tags = r.nodes.map((n) => n.tag);
    expect(tags).not.toContain("老 SSR");
    expect(tags).not.toContain("XHTTP");
    expect(tags).not.toContain("直连");
    expect(r.notes.join()).toContain("老 SSR（sing-box 已不支持 ShadowsocksR）");
    expect(r.notes.join()).toContain("XHTTP（sing-box 不支持 xhttp 传输）");
    expect(r.notes.join()).toContain("proxy-providers（机场）");
  });

  it("expands relay groups into chained copies named after the group", () => {
    const relay = body("🔗 链式");
    expect(relay).toMatchObject({ type: "vless", server: "us1.example.org", detour: "🇭🇰 香港 01" });
    expect(r.notes.join()).toContain("🇭🇰 香港 01 → 🇺🇸 美国 Reality");
  });

  it("converts the groups, expanding include-all and its filters", () => {
    expect(r.groups.map((g) => [g.tag, g.type])).toEqual([
      ["🚀 节点选择", "selector"],
      ["♻️ 自动选择", "urltest"],
      ["🇭🇰 香港节点", "urltest"],
      ["🐟 漏网之鱼", "selector"],
    ]);
    const [select, auto, hk, final] = r.groups;
    // DIRECT and the unsupported node go; the relay is listed by its name.
    expect(select.members.map(tagOf)).toEqual(["♻️ 自动选择", "🇭🇰 香港节点", "🔗 链式"]);
    // (?i) is Go's case-insensitive flag.
    const autoTags = auto.members.map(tagOf);
    expect(autoTags).not.toContain("家里 WireGuard");
    expect(autoTags).not.toContain("跳板 SOCKS");
    expect(autoTags).toContain("🇹🇼 台湾 TUIC");
    expect(autoTags).not.toContain("🇯🇵 日本 ShadowTLS-shadowtls");
    expect(auto).toMatchObject({ testUrl: "", interval: "5m", tolerance: 80 });
    expect(hk.members.map(tagOf)).toEqual(["🇭🇰 香港 01", "🇭🇰 香港 02 obfs"]);
    expect(hk.interval).toBe("");
    // The ad-block group only had REJECT and DIRECT, so it and the reference to it go.
    expect(final.members.map(tagOf)).toEqual(["🚀 节点选择"]);
    expect(r.notes.join()).toContain("「🛑 广告拦截」没有可导入的成员");
    expect(r.notes.join()).toContain("「🇭🇰 香港节点」已改为自动测速");
    expect(r.notes.join()).toContain("DIRECT、REJECT");
  });

  it("offers the nodes the groups listed", () => {
    const offered = r.nodes.filter((n) => n.inGroups).map((n) => n.tag);
    expect(offered).toContain("🔗 链式");
    expect(offered).not.toContain("家里 WireGuard");
    expect(offered).not.toContain("落地 HTTP");
  });

  it("makes a profile without errors that matches the 1.14 schema", () => {
    const { nodes, groups } = fitImport(r);
    const profile = { ...base, nodes, groups };
    expect(issues(profile).filter((i) => i.level === "error")).toEqual([]);
    const config = generateConfig(profile) as any;
    validate(config);
    expect(validate.errors ?? []).toEqual([]);
    expect(config.endpoints.map((e: any) => e.tag)).toContain("家里 WireGuard");
  });
});

describe("Clash configs without groups, and broken ones", () => {
  it("offers every node when there are no groups", () => {
    const r = importClashConfig(`
proxies:
  - { name: a, type: trojan, server: a.example.org, port: 443, password: p }
  - { name: b, type: ss, server: b.example.org, port: 443, cipher: aes-128-gcm, password: p, plugin: shadow-tls, plugin-opts: { host: h, password: x } }
`);
    expect(r.nodes.map((n) => [n.tag, n.inGroups])).toEqual([
      ["a", true],
      ["b", true],
      ["b-shadowtls", false],
    ]);
    expect(r.groups).toEqual([]);
  });

  it("reports what is wrong", () => {
    expect(() => importConfig("proxies: [a")).toThrow("不是有效的 YAML");
    expect(() => importConfig("mode: rule\n")).toThrow("这不像是 Clash 配置");
    expect(() => importConfig("proxies:\n  - { name: x, type: ssr, server: s, port: 1 }\n")).toThrow("没有可导入的节点");
    // JSON-looking text is still read as sing-box.
    expect(() => importConfig("{ nope")).toThrow("不是有效的 JSON");
  });

  it("falls back to every node when a filter is not a valid regular expression", () => {
    const r = importClashConfig(`
proxies:
  - { name: a, type: trojan, server: a.example.org, port: 443, password: p }
proxy-groups:
  - { name: g, type: select, include-all: true, filter: "(" }
`);
    expect(r.groups[0].members).toEqual([r.nodes[0].id]);
    expect(r.notes.join()).toContain("filter 不是有效的正则表达式");
  });

  it("skips relays it can't chain", () => {
    const r = importClashConfig(`
proxies:
  - { name: a, type: trojan, server: a.example.org, port: 443, password: p }
proxy-groups:
  - { name: g, type: select, proxies: [a] }
  - { name: r, type: relay, proxies: [a, g] }
`);
    expect(r.nodes.map((n) => n.tag)).toEqual(["a"]);
    expect(r.notes.join()).toContain("relay 组「r」");
  });
});
