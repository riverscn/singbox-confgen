export interface ProxyNode {
  id: string;
  /** Outbound/endpoint tag. */
  tag: string;
  /** Outbound or endpoint body as JSON with comments; `type` picks the protocol, `tag` is filled in. */
  body: string;
  /** Offer it in the `proxy` selector and the `auto` url-test group. */
  inGroups: boolean;
}

export type Platform = "apple" | "android" | "linux" | "windows";
export type RemoteDnsProvider = "google" | "cloudflare" | "quad9";
export type RemoteDnsChoice = RemoteDnsProvider | "custom";
export type RemoteDnsProtocol = "tls" | "https";

export interface Tailnet {
  id: string;
  /** Endpoint tag; the DNS server tag is `<tag>-dns`. */
  tag: string;
  /** Endpoint body as JSON (comments allowed). `type` and `tag` are filled in by the generator. */
  endpoint: string;
  /** Resolve MagicDNS names and the tailnet's DNS route suffixes through it. */
  magicDns: boolean;
  /** Also use the tailnet's default (global) resolvers for names routed to it. */
  acceptDefaultResolvers: boolean;
  /** Lines as entered: extra domains or IP prefixes routed through this tailnet. */
  routes: string[];
  /** Offer the endpoint as a choice in the `proxy` selector (e.g. to use an exit node). */
  asProxy: boolean;
  /** Exit node for the endpoint (`exit_node`); the endpoint JSON's own is ignored. */
  exitNode: string;
}

export interface RouteRule {
  id: string;
  /** Id of the node or group that matching traffic goes through. */
  outbound: string;
  /** Lines as entered: domains or IP prefixes, in the same syntax as the other lists. */
  lines: string[];
}

export type DnsRuleServer = "local" | "remote" | "tailnet" | "custom";

export interface DnsRule {
  id: string;
  /** local: the network's resolver; remote: the proxy DNS; tailnet: that tailnet's DNS; custom: the JSON below. */
  server: DnsRuleServer;
  /** Id of the tailnet whose DNS is used when server is "tailnet". */
  tailnet: string;
  /** DNS server body as JSON with comments, used when server is "custom". */
  custom: string;
  /** Lines as entered: domains resolved by this server. */
  lines: string[];
}

export interface Settings {
  platform: Platform;
  defaultMode: "GFWList" | "Non-CN" | "Global" | "Direct";
  remoteDns: {
    provider: RemoteDnsChoice;
    protocol: RemoteDnsProtocol;
    /** DNS server body as JSON with comments, used when provider is "custom". */
    custom: string;
  };
  /** EDNS client subnet sent with queries to the remote resolver; empty disables it. */
  clientSubnet: string;
  /** Clash API listen address; empty disables the API. */
  clashController: string;
  clashSecret: string;
  /** Lines as entered: domains or IP prefixes that always go direct except in Global mode. */
  directDomains: string[];
  /** Lines as entered: domains or IP prefixes that always go through the proxy. */
  proxyRules: string[];
  /** Traffic sent to a chosen node or group, checked in order after the direct list. */
  rules: RouteRule[];
  /** Domains resolved by a chosen DNS server, checked in order before the other DNS rules. */
  dnsRules: DnsRule[];
  tailnets: Tailnet[];
  /** What `proxy` picks by default: "auto" or a group id. */
  proxyDefault: string;
  /** List nodes one by one in `proxy`, next to `auto` and the groups. */
  listNodesInProxy: boolean;
  /** Resolve `lancache.steamcontent.com` locally and keep Steam downloads direct in Non-CN mode. */
  steam: boolean;
  /** Reject QUIC to gateway.icloud.com so iCloud falls back to TCP through the rules. */
  blockIcloudQuic: boolean;
}

export interface ProxyGroup {
  id: string;
  tag: string;
  /** selector: picked by hand in the client; urltest: the fastest member is used. */
  type: "selector" | "urltest";
  /** Ids of member nodes, tailnets or other groups, in order. */
  members: string[];
  /** selector: id of the member picked by default; empty means the first. */
  defaultMember: string;
  /** urltest overrides; empty means sing-box's default. */
  testUrl: string;
  interval: string;
  tolerance: number | null;
}

export interface Profile {
  version: 2;
  nodes: ProxyNode[];
  groups: ProxyGroup[];
  settings: Settings;
}
