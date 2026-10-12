#!/usr/bin/env python3
"""Full schema diff across all common tables between test and prod bases."""
import json, os, sys

TMP = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(TMP, "all")

test_tables = {t["id"]: t["name"] for t in json.load(open(os.path.join(TMP, "test-tables.json")))["data"]["tables"]}
prod_tables = {t["id"]: t["name"] for t in json.load(open(os.path.join(TMP, "prod-tables.json")))["data"]["tables"]}
common = [l.rstrip("\n").split("\t") for l in open(os.path.join(TMP, "common-map.tsv")) if l.strip()]


def load(tag, name):
    safe = name.replace("/", "_")
    p = os.path.join(D, f"{tag}__{safe}.json")
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    return d["data"]["fields"] if d.get("ok") else None


def norm(f, tables):
    t = f.get("type")
    prop = f.get("property") or {}
    opts = None
    if t in ("select", "multi_select", "single_select"):
        raw = prop.get("options") or f.get("options") or []
        opts = [o.get("name") for o in raw]
    lt = f.get("link_table") or prop.get("table_id")
    link_to = None
    if t == "link" and lt:
        link_to = tables.get(lt) or f"<unknown:{lt}>"
    out = {"type": t, "options": opts, "link_to": link_to}
    if t == "formula":
        out["expr"] = f.get("expression")
    return out


rows = []
summary = []
for name, tid, pid in common:
    tf, pf = load("test", name), load("prod", name)
    if tf is None or pf is None:
        summary.append((name, f"READ-FAIL test={tf is None} prod={pf is None}"))
        continue
    tmap = {f["name"]: norm(f, test_tables) for f in tf}
    pmap = {f["name"]: norm(f, prod_tables) for f in pf}
    only_p = [n for n in pmap if n not in tmap]
    only_t = [n for n in tmap if n not in pmap]
    diff = []
    for n in tmap:
        if n not in pmap:
            continue
        a, b = tmap[n], pmap[n]
        m = []
        if a["type"] != b["type"]:
            m.append(f"类型 {a['type']} -> {b['type']}")
        if a["options"] is not None and b["options"] is not None and a["options"] != b["options"]:
            m.append(f"选项 {a['options']} -> {b['options']}")
        if a["link_to"] != b["link_to"]:
            m.append(f"关联 {a['link_to']} -> {b['link_to']}")
        if a.get("expr") != b.get("expr"):
            m.append("公式体不同")
        if m:
            diff.append((n, " | ".join(m)))
    if only_p or only_t or diff:
        rows.append((name, only_p, only_t, diff, tmap, pmap))
        summary.append((name, f"缺{len(only_p)} 多{len(only_t)} 不一致{len(diff)}"))

print("############ 全量差异清单（53 张共有表） ############\n")
for name, only_p, only_t, diff, tmap, pmap in rows:
    print("=" * 70)
    print(f"### {name}")
    for n in only_p:
        p = pmap[n]
        d = f"  [缺] 生产有测试没有: {n}  type={p['type']}"
        if p["options"] is not None:
            d += f" options={p['options']}"
        if p["link_to"]:
            d += f" link_to={p['link_to']}"
        print(d)
    for n in only_t:
        p = tmap[n]
        d = f"  [多] 测试有生产没有: {n}  type={p['type']}"
        if p["options"] is not None:
            d += f" options={p['options']}"
        if p["link_to"]:
            d += f" link_to={p['link_to']}"
        print(d)
    for n, m in diff:
        print(f"  [异] {n}: {m}")
    print()

print("\n############ 汇总 ############")
for name, s in summary:
    print(f"{name}\t{s}")
print(f"\n有差异的表: {len(rows)} / {len(common)}")
