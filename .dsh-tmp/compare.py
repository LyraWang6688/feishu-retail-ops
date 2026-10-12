#!/usr/bin/env python3
"""Compare field schemas between test and prod bases (read-only analysis)."""
import json, sys, os

TMP = os.path.dirname(os.path.abspath(__file__))
F = os.path.join(TMP, "fields")

test_tables = {t["id"]: t["name"] for t in json.load(open(os.path.join(TMP, "test-tables.json")))["data"]["tables"]}
prod_tables = {t["id"]: t["name"] for t in json.load(open(os.path.join(TMP, "prod-tables.json")))["data"]["tables"]}


def load(tag, name):
    p = os.path.join(F, f"{tag}__{name}.json")
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    if not d.get("ok"):
        return None
    return d["data"]["fields"]


def norm(f, tables):
    """Normalize a field into comparable primitives."""
    t = f.get("type")
    out = {"name": f.get("name"), "type": t, "id": f.get("id")}
    # select options
    opts = None
    prop = f.get("property") or {}
    if t in ("single_select", "multi_select"):
        opts = [o.get("name") for o in (prop.get("options") or f.get("options") or [])]
    out["options"] = opts
    # link target table name
    lt = f.get("link_table") or prop.get("table_id")
    if t == "link" and lt:
        nm = tables.get(lt)
        out["link_to_id"] = lt
        out["link_to"] = nm if nm else f"<unknown:{lt}>"
    else:
        out["link_to"] = None
    # formula expression
    if t == "formula":
        out["expr"] = f.get("expression")
    # lookup / rollup
    if t in ("lookup", "rollup"):
        out["extra"] = json.dumps({k: v for k, v in f.items() if k not in ("id", "name", "type")}, ensure_ascii=False, sort_keys=True)
    return out


def cmp_pair(label, tname, pname):
    tf = load("test", tname)
    pf = load("prod", pname)
    print("=" * 78)
    print(f"### {label}   [test: {tname}]  vs  [prod: {pname}]")
    if tf is None:
        print(f"  !! 测试 Base 无此表/读取失败: {tname}")
        return
    if pf is None:
        print(f"  !! 生产 Base 无此表/读取失败: {pname}")
        return
    tmap = {f["name"]: norm(f, test_tables) for f in tf}
    pmap = {f["name"]: norm(f, prod_tables) for f in pf}
    print(f"  字段数: test={len(tf)}  prod={len(pf)}")
    only_t = [n for n in tmap if n not in pmap]
    only_p = [n for n in pmap if n not in tmap]
    common = [n for n in tmap if n in pmap]

    if only_p:
        print(f"\n  [缺字段] 生产有、测试没有 ({len(only_p)}):")
        for n in only_p:
            p = pmap[n]
            d = f"      type={p['type']}"
            if p["options"] is not None:
                d += f" options={p['options']}"
            if p["link_to"]:
                d += f" link_to={p['link_to']}"
            if p.get("expr"):
                d += f" expr={p['expr']}"
            print(f"    - {n}{d}")
    if only_t:
        print(f"\n  [多字段] 测试有、生产没有 ({len(only_t)}):")
        for n in only_t:
            p = tmap[n]
            d = f"      type={p['type']}"
            if p["options"] is not None:
                d += f" options={p['options']}"
            if p["link_to"]:
                d += f" link_to={p['link_to']}"
            print(f"    - {n}{d}")
    diffs = 0
    print(f"\n  [逐字段差异] (共有 {len(common)} 个):")
    for n in common:
        a, b = tmap[n], pmap[n]
        msgs = []
        if a["type"] != b["type"]:
            msgs.append(f"类型 test={a['type']} -> prod={b['type']}")
        if a["options"] is not None and b["options"] is not None and a["options"] != b["options"]:
            msgs.append(f"选项 test={a['options']} -> prod={b['options']}")
        if a["link_to"] != b["link_to"]:
            msgs.append(f"关联指向 test={a['link_to']} -> prod={b['link_to']}")
        if a.get("expr") != b.get("expr"):
            msgs.append(f"公式 test={a.get('expr')} -> prod={b.get('expr')}")
        if msgs:
            diffs += 1
            print(f"    * {n}: " + " | ".join(msgs))
    if not diffs:
        print("    (共有字段全部一致)")
    if not only_p and not only_t and not diffs:
        print("\n  ==> 完全一致 ✔")
    else:
        print(f"\n  ==> 差异: 缺{len(only_p)} / 多{len(only_t)} / 不一致{diffs}")


if __name__ == "__main__":
    pairs = [
        ("报表链路-候选改名对", "供应商报货", "供应商对接"),
        ("报表链路-候选改名对", "采购申请", "单据信息"),
        ("库存", "库存流水", "库存流水"),
        ("库存", "实时库存", "实时库存"),
        ("主数据", "货品信息", "货品信息"),
        ("主数据", "尺码管理", "尺码管理"),
        ("主数据", "行为管理", "行为管理"),
        ("主数据", "其他配品", "其他配品"),
        ("销售", "销售主表", "销售主表"),
        ("销售", "销售明细", "销售明细"),
        ("销售", "收款明细", "收款明细"),
    ]
    for label, t, p in pairs:
        cmp_pair(label, t, p)
        print()
