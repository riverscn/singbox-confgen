import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { generateConfig, validate as issues } from "../src/generate";
import { fitImport, importConfig } from "../src/importer";
import { curlCommand, decodeBase64 } from "../src/subscription";
import { sampleProfiles } from "./samples";

const schema = JSON.parse(readFileSync(new URL("./fixtures/sing-box-1.14.3.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const base = sampleProfiles().find((s) => s.name === "full-apple")!.profile;

import { LINKS, UUID, b64, b64url } from "./subscription-links";

describe("importing subscription content", () => {
  const r = importConfig(b64(LINKS.join("\r\n")));
  const body = (tag: string) => JSON.parse(r.nodes.find((n) => n.tag === tag)!.body);

  it("reads base64 share links, plain ones too, keeping names and order", () => {
    expect(r.nodes.map((n) => n.tag).slice(0, 4)).toEqual(["🇭🇰 香港 SS", "SS2022", "Legacy", "Obfs"]);
    expect(importConfig(LINKS.join("\n")).nodes.map((n) => n.tag)).toEqual(r.nodes.map((n) => n.tag));
    expect(r.groups).toEqual([]);
  });

  it("maps Shadowsocks in every form", () => {
    expect(body("🇭🇰 香港 SS")).toEqual({ type: "shadowsocks", server: "ss.example.org", server_port: 8388, method: "aes-256-gcm", password: "pass" });
    expect(body("SS2022")).toMatchObject({ method: "2022-blake3-aes-128-gcm", password: "AAAAAAAAAAAAAAAAAAAAAA==", udp_over_tcp: { enabled: true, version: 1 } });
    expect(body("Legacy")).toMatchObject({ server: "legacy.example.org", server_port: 8389, method: "chacha20-ietf-poly1305", password: "pw" });
    expect(body("Obfs")).toMatchObject({ plugin: "obfs-local", plugin_opts: "obfs=http;obfs-host=bing.com" });
  });

  it("maps v2rayN VMess links", () => {
    expect(body("VMess WS")).toEqual({
      type: "vmess",
      server: "vm.example.org",
      server_port: 443,
      uuid: UUID,
      tls: { enabled: true, server_name: "cdn.example.org" },
      transport: { type: "ws", path: "/ws", headers: { Host: "cdn.example.org" }, max_early_data: 2048, early_data_header_name: "Sec-WebSocket-Protocol" },
    });
    expect(body("VMess gRPC")).toMatchObject({ transport: { type: "grpc", service_name: "svc" }, tls: { server_name: "vm2.example.org" } });
    expect(body("VMess TCP")).toEqual({ type: "vmess", server: "vm3.example.org", server_port: 80, uuid: UUID });
  });

  it("maps VLESS with REALITY, keeping the short ID a string", () => {
    expect(body("Reality")).toEqual({
      type: "vless",
      server: "re.example.org",
      server_port: 443,
      uuid: UUID,
      flow: "xtls-rprx-vision",
      tls: {
        enabled: true,
        server_name: "www.apple.com",
        utls: { enabled: true, fingerprint: "chrome" },
        reality: { enabled: true, public_key: "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0", short_id: "08" },
      },
    });
    expect(body("VLESS WS")).toMatchObject({ transport: { type: "ws", path: "/vl", headers: { Host: "ws.example.org" } } });
  });

  it("maps Trojan, Hysteria, TUIC, AnyTLS, SOCKS and WireGuard", () => {
    expect(body("Trojan")).toMatchObject({ password: "p@ss", tls: { insecure: true, server_name: "tj.example.org" }, transport: { type: "grpc", service_name: "tg" } });
    expect(body("Hy2")).toMatchObject({ password: "pw", server_ports: ["20000:30000"], obfs: { type: "salamander", password: "ob" }, tls: { insecure: true } });
    expect(body("Hy2 hop")).toMatchObject({ server_port: 443, server_ports: ["443:443", "5000:6000"] });
    expect(body("Hy1")).toMatchObject({ auth_str: "a", obfs: "secret", up_mbps: 50, down_mbps: 100, tls: { server_name: "hy1.example.org" } });
    expect(body("TUIC")).toMatchObject({ uuid: UUID, password: "pw", congestion_control: "bbr", udp_relay_mode: "native", tls: { insecure: true, alpn: ["h3"] } });
    expect(body("AnyTLS")).toMatchObject({ type: "anytls", password: "pw", tls: { server_name: "any.example.org", insecure: true } });
    expect(body("SOCKS")).toMatchObject({ type: "socks", version: "5", username: "user", password: "pass" });
    expect(body("WG")).toMatchObject({ type: "wireguard", address: ["10.0.0.2/32", "fd00::2/128"], mtu: 1280, peers: [{ address: "wg.example.org", port: 51820, reserved: [1, 2, 3] }] });
  });

  it("names what sing-box can't run", () => {
    expect(r.nodes.map((n) => n.tag)).not.toContain("XHTTP");
    expect(r.notes.join("\n")).toMatch(/XHTTP（sing-box 不支持 xhttp 传输）/);
    expect(r.notes.join("\n")).toMatch(/老节点（sing-box 已不支持 ShadowsocksR）/);
  });

  it("makes a profile without errors that matches the 1.14 schema", () => {
    const { nodes, groups } = fitImport(r);
    const profile = { ...base, nodes, groups };
    expect(issues(profile).filter((i) => i.level === "error")).toEqual([]);
    validate(generateConfig(profile));
    expect(validate.errors ?? []).toEqual([]);
  });

  it("renames repeated names and skips broken links", () => {
    const dup = importConfig([LINKS[0], LINKS[0], "vless://broken", "trojan://"].join("\n"));
    expect(dup.nodes.map((n) => n.tag)).toEqual(["🇭🇰 香港 SS", "🇭🇰 香港 SS 2"]);
    expect(dup.notes.join()).toMatch(/跳过/);
  });

  it("reads SIP008 and a Clash config sent as base64", () => {
    const sip = importConfig(JSON.stringify({ version: 1, servers: [{ id: "x", remarks: "SIP", server: "s.example.org", server_port: 8388, password: "p", method: "aes-256-gcm", plugin: "obfs-local", plugin_opts: "obfs=tls;obfs-host=a.com" }] }));
    expect(JSON.parse(sip.nodes[0].body)).toMatchObject({ type: "shadowsocks", plugin: "obfs-local", plugin_opts: "obfs=tls;obfs-host=a.com" });
    const yaml = "proxies:\n  - {name: a, type: trojan, server: a.example.org, port: 443, password: p}\n";
    expect(importConfig(b64(yaml)).nodes.map((n) => n.tag)).toEqual(["a"]);
  });

  it("explains a pasted URL or web page instead of importing it", () => {
    expect(() => importConfig("https://panel.example.org/api/v1/client/subscribe?token=abc")).toThrow(/不是订阅内容/);
    expect(() => importConfig("<!DOCTYPE html><html></html>")).toThrow(/网页/);
  });
});

describe("helpers", () => {
  it("decodes URL-safe base64 without padding as UTF-8", () => {
    expect(decodeBase64(b64url("香港?>"))).toBe("香港?>");
    expect(decodeBase64("not base64!")).toBeNull();
  });
  it("quotes the URL for the shell", () => {
    expect(curlCommand("https://a.example.org/s/x?a=1&b='2'")).toBe(`curl -fsSL -A 'clash.meta' 'https://a.example.org/s/x?a=1&b='\\''2'\\''' -o subscription.yaml`);
  });
});
