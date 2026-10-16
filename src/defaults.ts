import type { Profile, ProxyGroup, ProxyNode, RouteRule, Settings, Tailnet } from "./types";
import { TEMPLATES } from "./templates";

const uid = () => Math.random().toString(36).slice(2, 10);

export function newNode(partial: Partial<ProxyNode> = {}): ProxyNode {
  const template = TEMPLATES[0];
  return { id: uid(), tag: `${template.tagPrefix}-1`, body: template.body, inGroups: true, ...partial };
}

/** A tag based on the template's prefix that is not used yet. */
export function freshTag(prefix: string, used: string[]): string {
  for (let i = 1; ; i++) if (!used.includes(`${prefix}-${i}`)) return `${prefix}-${i}`;
}

export const CUSTOM_DNS_TEMPLATE = `{
  // 任意 sing-box DNS 服务器，经代理访问：tcp / udp / tls / https / quic / h3
  // 详见 https://sing-box.sagernet.org/zh/configuration/dns/server/
  "type": "https",
  "server": "1.1.1.1",
  "server_port": 443,
  "path": "/dns-query",
  "tls": { "enabled": true, "server_name": "cloudflare-dns.com" }
}`;

/** A fresh Clash API secret: without one, any web page can reach the API on 127.0.0.1. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

export const defaultSettings = (): Settings => ({
  platform: "apple",
  defaultMode: "GFWList",
  remoteDns: { provider: "google", protocol: "tls", custom: CUSTOM_DNS_TEMPLATE },
  clientSubnet: "",
  clashController: "127.0.0.1:9090",
  clashSecret: randomSecret(),
  directDomains: [],
  proxyRules: [],
  rules: [],
  tailnets: [],
  proxyDefault: "auto",
  listNodesInProxy: true,
  steam: false,
  blockIcloudQuic: false,
});

export const TAILSCALE_ENDPOINT_TEMPLATE = `{
  // 登录状态的保存目录；有多个 tailnet 时，每个要用不同的目录
  "state_directory": "tailscale",
  // 在 Tailscale 管理后台显示的设备名
  "hostname": "my-device",
  // 接收其他设备通告的子网路由
  "accept_routes": true
  // 其他可用字段：control_url（自建 Headscale）、auth_key、advertise_routes 等；出口节点填在下面的「出口节点」里
  // 详见 https://sing-box.sagernet.org/zh/configuration/endpoint/tailscale/
}`;

export function newTailnet(partial: Partial<Tailnet> = {}): Tailnet {
  return {
    id: uid(),
    tag: "ts",
    endpoint: TAILSCALE_ENDPOINT_TEMPLATE,
    magicDns: true,
    acceptDefaultResolvers: false,
    dnsDomains: [],
    routes: [],
    asProxy: false,
    exitNode: "",
    ...partial,
  };
}

export function newRule(partial: Partial<RouteRule> = {}): RouteRule {
  return { id: uid(), outbound: "", lines: [], ...partial };
}

export function newGroup(partial: Partial<ProxyGroup> = {}): ProxyGroup {
  return { id: uid(), tag: "group", type: "selector", members: [], defaultMember: "", testUrl: "", interval: "", tolerance: null, ...partial };
}

/** Example profile for first-time visitors: two template nodes, no personal settings. */
export function blueprintProfile(): Profile {
  const reality = TEMPLATES.find((t) => t.id === "vless-reality")!;
  return {
    version: 2,
    nodes: [newNode({ tag: "hy2-1" }), newNode({ tag: "reality-1", body: reality.body })],
    groups: [],
    settings: defaultSettings(),
  };
}
