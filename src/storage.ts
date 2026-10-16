import type { Profile, ProxyGroup, ProxyNode, RouteRule, Tailnet } from "./types";
import { legacyServersToNodes, type LegacyServer } from "./legacy";
import { blueprintProfile, defaultSettings, newGroup, newNode, newRule, newTailnet } from "./defaults";

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
  const tailnets = Array.isArray(raw.tailnets) ? (raw.tailnets as Partial<Tailnet>[]) : [];
  return {
    ...base,
    ...raw,
    remoteDns: { ...base.remoteDns, ...((raw.remoteDns as object) ?? {}) },
    tailnets: tailnets.map((t) => newTailnet(t)),
    rules: Array.isArray(raw.rules) ? (raw.rules as Partial<RouteRule>[]).map((r) => newRule(r)) : [],
  } as Profile["settings"];
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
