import type { DnsRule, Profile, ProxyGroup, ProxyNode, RouteRule, RuleSetRef, Tailnet } from "./types";
import { legacyServersToNodes, type LegacyServer } from "./legacy";
import { blueprintProfile, defaultSettings, newDnsRule, newGroup, newNode, newRule, newTailnet } from "./defaults";

const KEY = "singbox-gen:profile";

/** Fill missing fields so older or hand-edited exports still load. */
export function normalizeProfile(raw: unknown): Profile {
  const { nodes, servers, groups, settings } = (raw ?? {}) as {
    nodes?: unknown;
    groups?: unknown;
    servers?: unknown;
    settings?: Record<string, unknown>;
  };
  let list: Partial<ProxyNode>[];
  if (Array.isArray(nodes)) list = nodes;
  else if (Array.isArray(servers)) list = legacyServersToNodes(servers as Partial<LegacyServer>[]); // version 1
  else throw new Error("缺少 nodes 数组");
  return {
    version: 2,
    nodes: list.map((n) => newNode(n)),
    groups: Array.isArray(groups) ? (groups as Partial<ProxyGroup>[]).map((g) => newGroup(g)) : [],
    settings: normalizeSettings(settings ?? {}),
  };
}

function normalizeSettings(raw: Record<string, unknown>): Profile["settings"] {
  const base = defaultSettings();
  const rawTailnets = Array.isArray(raw.tailnets) ? (raw.tailnets as (Partial<Tailnet> & { dnsDomains?: unknown })[]) : [];
  // A tailnet's split-DNS domains used to live on the tailnet; they are now DNS rules to its DNS,
  // ahead of the others as they used to be.
  const moved: DnsRule[] = [];
  const tailnets = rawTailnets.map(({ dnsDomains, ...rest }) => {
    const t = newTailnet(rest);
    const lines = Array.isArray(dnsDomains) ? dnsDomains.filter((l): l is string => typeof l === "string") : [];
    if (lines.some((l) => l.trim())) moved.push(newDnsRule({ server: "tailnet", tailnet: t.id, lines }));
    return t;
  });
  const dnsRules = Array.isArray(raw.dnsRules) ? (raw.dnsRules as Partial<DnsRule>[]).map((r) => newDnsRule(r)) : [];
  return {
    ...base,
    ...raw,
    remoteDns: { ...base.remoteDns, ...((raw.remoteDns as object) ?? {}) },
    tailnets,
    rules: Array.isArray(raw.rules) ? (raw.rules as Partial<RouteRule>[]).map((r) => newRule({ ...r, ruleSets: ruleSetRefs(r.ruleSets) })) : [],
    dnsRules: [...moved, ...dnsRules],
  } as Profile["settings"];
}

/** Rule-set references as saved, without malformed entries (rules from before them have none). */
function ruleSetRefs(raw: unknown): RuleSetRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const { source, content } = (x ?? {}) as Partial<RuleSetRef>;
    if (typeof source !== "string") return [];
    return [{ source, content: content === "ip" || content === ("both" as string) ? "ip" : "domain" }];
  });
}

export interface SavedProfile {
  id: string;
  name: string;
  profile: Profile;
}

/** All profiles kept in this browser, and which one is being edited. */
export interface Store {
  activeId: string;
  profiles: SavedProfile[];
}

const STORE_KEY = "singbox-gen:profiles";
const LEGACY_KEY = "singbox-gen:profile"; // single profile, before multiple profiles existed

const uid = () => Math.random().toString(36).slice(2, 10);

export function newSavedProfile(name: string, profile: Profile = blueprintProfile()): SavedProfile {
  return { id: uid(), name, profile };
}

export function defaultStore(): Store {
  const first = newSavedProfile("默认");
  return { activeId: first.id, profiles: [first] };
}

/** Accepts the store format, or a single profile from before multiple profiles existed. */
export function normalizeStore(raw: unknown): Store {
  const r = (raw ?? {}) as { activeId?: unknown; profiles?: unknown };
  if (!Array.isArray(r.profiles)) {
    const only = newSavedProfile("默认", normalizeProfile(raw));
    return { activeId: only.id, profiles: [only] };
  }
  const profiles = (r.profiles as Partial<SavedProfile>[]).map((p) => ({
    id: typeof p.id === "string" && p.id ? p.id : uid(),
    name: typeof p.name === "string" && p.name ? p.name : "未命名",
    profile: normalizeProfile(p.profile),
  }));
  if (!profiles.length) return defaultStore();
  const activeId = profiles.some((p) => p.id === r.activeId) ? String(r.activeId) : profiles[0].id;
  return { activeId, profiles };
}

export function loadStore(): Store {
  try {
    const text = localStorage.getItem(STORE_KEY);
    if (text) return normalizeStore(JSON.parse(text));
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return normalizeStore(JSON.parse(legacy));
  } catch {
    // Storage blocked or corrupt: start over with the example.
  }
  return defaultStore();
}

export function saveStore(store: Store): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Ignore: private mode or blocked storage.
  }
}

export function clearStore(): void {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Ignore.
  }
}
