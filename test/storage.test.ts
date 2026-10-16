import { describe, expect, it } from "vitest";
import { normalizeStore } from "../src/storage";

describe("normalizeStore", () => {
  it("defaults rules for profiles saved before them, and fills in missing fields", () => {
    const old = normalizeStore({ version: 2, nodes: [], settings: {} });
    expect(old.profiles[0].profile.settings.rules).toEqual([]);
    const [r] = normalizeStore({ version: 2, nodes: [], settings: { rules: [{ outbound: "n1" }] } }).profiles[0].profile.settings.rules;
    expect(r).toMatchObject({ outbound: "n1", lines: [] });
    expect(r.id).toMatch(/\w+/);
  });

  it("turns a single saved profile (before multiple profiles) into a store", () => {
    const store = normalizeStore({ version: 2, nodes: [{ tag: "a", body: "{}" }], settings: { directDomains: ["x.example"] } });
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0].name).toBe("默认");
    expect(store.activeId).toBe(store.profiles[0].id);
    expect(store.profiles[0].profile.nodes[0].tag).toBe("a");
    expect(store.profiles[0].profile.settings.directDomains).toEqual(["x.example"]);
  });

  it("migrates a v1 single profile all the way to nodes", () => {
    const store = normalizeStore({ servers: [{ name: "old", host: "h.example", vless: { enabled: false } }] });
    expect(store.profiles[0].profile.nodes.map((n) => n.tag)).toEqual(["old-hy2"]);
  });

  it("keeps profiles, names and the active one", () => {
    const store = normalizeStore({
      activeId: "b",
      profiles: [
        { id: "a", name: "Mac", profile: { nodes: [] } },
        { id: "b", name: "iPhone", profile: { nodes: [] } },
      ],
    });
    expect(store.profiles.map((p) => [p.id, p.name])).toEqual([
      ["a", "Mac"],
      ["b", "iPhone"],
    ]);
    expect(store.activeId).toBe("b");
  });

  it("falls back to the first profile when the active one is missing, and to the example when empty", () => {
    expect(normalizeStore({ activeId: "zzz", profiles: [{ id: "a", name: "A", profile: { nodes: [] } }] }).activeId).toBe("a");
    const empty = normalizeStore({ profiles: [] });
    expect(empty.profiles).toHaveLength(1);
    expect(empty.profiles[0].profile.nodes.length).toBeGreaterThan(0);
  });
});
