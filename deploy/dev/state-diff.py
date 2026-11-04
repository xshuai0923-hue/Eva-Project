#!/usr/bin/env python3
"""对账两份 state-snapshot.rb 快照，判定升级是否只做了手册承诺的追加性改动。

用法：
    state-diff.py before.json after.json   # 完整对账：既查破坏，也查该做的有没有做
    state-diff.py after.json               # 只查该做的有没有做（没留升级前快照时的退路）

退出码 0 表示通过；1 表示有违约项或该做的没做；2 表示用法或读取错误。

这里编码的是 docs/handoff-production-upgrade.md 那张表的承诺：新增类型、新增 9 个字段、
复制工作流、给两个枚举追加 Mila、给共用字段追加交接绑定——除此之外任何既有数据的变化
都算违约。判定不看"配置有没有写进去"，看的是"既有的东西有没有少"。
"""

import json
import sys

HANDOFF_TYPE = "交接"

HANDOFF_FIELDS = [
    "交接线程", "交接状态", "上一任交接", "期望接手 Agent",
    "仓库", "分支", "基线提交", "待办总数", "已完成待办",
]

# 需求与交接真正共用的字段：升级后它们的 types 里应当多出「交接」。
SHARED_FIELDS = [
    "需求 ID", "需求提交人", "可见性", "模块", "来源 Session",
    "实际认领 Agent", "认领 Session", "认领标签", "认领时间", "认领范围",
]

ENUM_ADDITIONS = {"负责 Agent": "Mila", "实际认领 Agent": "Mila"}

EXPECTED_FIELD_TOTAL = 35

breaks: list[str] = []
missing: list[str] = []
notes: list[str] = []


def broke(msg: str) -> None:
    breaks.append(msg)


def absent(msg: str) -> None:
    missing.append(msg)


def note(msg: str) -> None:
    notes.append(msg)


def is_subsequence(small, big) -> bool:
    """small 的元素是否按原有相对顺序全部出现在 big 里。"""
    it = iter(big)
    return all(item in it for item in small)


def check_unchanged(label, before, after, path):
    b = before
    a = after
    for key in path:
        b = b.get(key, {}) if isinstance(b, dict) else {}
        a = a.get(key, {}) if isinstance(a, dict) else {}
    if b != a:
        broke(f"{label} 变了：{b!r} → {a!r}")


def diff(before, after):
    # ---- 工作包：一条都不该动 ----
    wb, wa = before["work_packages"], after["work_packages"]
    if wb["total"] != wa["total"]:
        broke(f"工作包总数 {wb['total']} → {wa['total']}（升级不创建也不删除工作包）")
    if wb["digest"] != wa["digest"]:
        broke("工作包内容摘要变了：有既有工作包的类型、状态、项目或标题被改动"
              "（若升级窗口内有人正常编辑，也会触发，需人工核对）")
    for type_name, count in wb["by_type"].items():
        now = wa["by_type"].get(type_name, 0)
        if now != count:
            broke(f"类型「{type_name}」下的工作包 {count} → {now}")

    # ---- 附件：文件和元数据都不该动 ----
    ab, aa = before["attachments"], after["attachments"]
    for key, label in (("total", "附件数"), ("bytes", "附件总字节"), ("digest", "附件摘要")):
        if ab[key] != aa[key]:
            broke(f"{label} 变了：{ab[key]!r} → {aa[key]!r}")

    # ---- 用户、项目、状态、查询：只能多不能少 ----
    lost_users = set(before["users"]["logins"]) - set(after["users"]["logins"])
    if lost_users:
        broke(f"用户消失：{sorted(lost_users)}")

    for identifier, info in before["projects"].items():
        now = after["projects"].get(identifier)
        if now is None:
            broke(f"项目消失：{identifier}")
            continue
        if now["id"] != info["id"]:
            broke(f"项目 {identifier} 的 id 变了：{info['id']} → {now['id']}")
        if info["active"] and not now["active"]:
            broke(f"项目 {identifier} 被归档了")
        gained = [t for t in now["types"] if t not in info["types"]]
        lost = [t for t in info["types"] if t not in now["types"]]
        if lost:
            broke(f"项目 {identifier} 丢了类型绑定：{lost}")
        if gained:
            note(f"项目 {identifier} 新增类型绑定：{gained}")

    lost_statuses = set(before["statuses"]) - set(after["statuses"])
    if lost_statuses:
        broke(f"状态消失：{sorted(lost_statuses)}")

    # 引导脚本首次运行会销毁三个演示用全局查询。重跑时这里必须一个不少。
    lost_queries = [q for q in before["queries"]["global"] if q not in after["queries"]["global"]]
    if lost_queries:
        broke(f"全局查询被删除：{lost_queries}（首次运行判定失效的典型症状）")
    if after["queries"]["total"] < before["queries"]["total"]:
        broke(f"查询总数减少：{before['queries']['total']} → {after['queries']['total']}")
    for identifier, count in before["queries"]["by_project"].items():
        now = after["queries"]["by_project"].get(identifier, 0)
        if now < count:
            broke(f"项目 {identifier} 的查询减少：{count} → {now}")

    # ---- 类型：不能少，既有类型的工作流不能被削 ----
    for type_name, info in before["types"].items():
        now = after["types"].get(type_name)
        if now is None:
            broke(f"类型消失：{type_name}")
            continue
        if now["id"] != info["id"]:
            broke(f"类型「{type_name}」的 id 变了：{info['id']} → {now['id']}")
        if now["workflow_count"] < info["workflow_count"]:
            broke(f"类型「{type_name}」的工作流迁移减少："
                  f"{info['workflow_count']} → {now['workflow_count']}")
    for type_name in after["types"]:
        if type_name not in before["types"]:
            note(f"新增类型：{type_name}（工作流 {after['types'][type_name]['workflow_count']} 条）")

    # ---- 自定义字段：既有字段的定义、绑定、选项、已填值都不能退 ----
    for name, info in before["custom_fields"].items():
        now = after["custom_fields"].get(name)
        if now is None:
            broke(f"自定义字段消失：{name}")
            continue
        if now["id"] != info["id"]:
            broke(f"字段「{name}」的 id 变了：{info['id']} → {now['id']}（引用它的数据会失效）")
        if now["format"] != info["format"]:
            broke(f"字段「{name}」的格式变了：{info['format']} → {now['format']}")
        if now["values_present"] < info["values_present"]:
            broke(f"字段「{name}」已填值减少："
                  f"{info['values_present']} → {now['values_present']}（数据丢失）")
        lost_types = [t for t in info["types"] if t not in now["types"]]
        if lost_types:
            broke(f"字段「{name}」丢了类型绑定：{lost_types}（表单上会静默消失）")
        gained_types = [t for t in now["types"] if t not in info["types"]]
        if gained_types:
            note(f"字段「{name}」新增类型绑定：{gained_types}")
        lost_options = [o for o in info["options"] if o not in now["options"]]
        if lost_options:
            broke(f"字段「{name}」丢了选项：{lost_options}")
        elif not is_subsequence(info["options"], now["options"]):
            broke(f"字段「{name}」既有选项的相对顺序被打乱：{info['options']} → {now['options']}")
        gained_options = [o for o in now["options"] if o not in info["options"]]
        if gained_options:
            note(f"字段「{name}」新增选项：{gained_options}")
    for name in after["custom_fields"]:
        if name not in before["custom_fields"]:
            note(f"新增字段：{name}")

    # ---- 设置：首次运行才该改的东西，重跑时不能动 ----
    sb, sa = before["settings"], after["settings"]
    if sb["welcome_text_digest"] != sa["welcome_text_digest"]:
        broke(f"欢迎页文本被覆盖（长度 {sb['welcome_text_length']} → {sa['welcome_text_length']}）"
              "：首次运行判定失效")
    if sb["work_package_list_default_columns"] != sa["work_package_list_default_columns"]:
        note(f"工作包列表默认列变更：{sb['work_package_list_default_columns']}"
             f" → {sa['work_package_list_default_columns']}")


def assert_outcomes(after):
    """该做的有没有做。只看升级后的快照。"""
    types = after["types"]
    fields = after["custom_fields"]

    if HANDOFF_TYPE not in types:
        absent(f"类型「{HANDOFF_TYPE}」不存在")
    elif types[HANDOFF_TYPE]["workflow_count"] <= 0:
        absent(f"类型「{HANDOFF_TYPE}」没有工作流迁移：任何状态变更都会 422")

    for name in HANDOFF_FIELDS:
        info = fields.get(name)
        if info is None:
            absent(f"交接字段缺失：{name}")
        elif info["types"] != [HANDOFF_TYPE]:
            absent(f"交接字段「{name}」的类型绑定应当只有「{HANDOFF_TYPE}」，实际是 {info['types']}"
                   "（绑多了会让需求表单长出交接字段）")

    for name in SHARED_FIELDS:
        info = fields.get(name)
        if info is None:
            absent(f"共用字段缺失：{name}")
        elif HANDOFF_TYPE not in info["types"]:
            absent(f"共用字段「{name}」没有绑定「{HANDOFF_TYPE}」：交接表单上读不到它")

    for name, value in ENUM_ADDITIONS.items():
        info = fields.get(name)
        if info is None:
            absent(f"字段缺失：{name}")
        elif value not in info["options"]:
            absent(f"字段「{name}」缺少选项「{value}」")

    total = len(fields)
    if total < EXPECTED_FIELD_TOTAL:
        absent(f"自定义字段共 {total} 个，少于预期的 {EXPECTED_FIELD_TOTAL}")
    elif total > EXPECTED_FIELD_TOTAL:
        note(f"自定义字段共 {total} 个，多于本次引导定义的 {EXPECTED_FIELD_TOTAL} 个"
             "（若该实例本来就有别的自定义字段，属正常）")


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        sys.exit(f"读不到快照 {path}：{error}")
    except json.JSONDecodeError as error:
        sys.exit(f"快照 {path} 不是合法 JSON：{error}\n"
                 "（常见原因：Rails runner 的日志混进了 stdout，检查文件开头）")


def main(argv):
    if len(argv) == 3:
        before, after = load(argv[1]), load(argv[2])
        print(f"升级前快照：{before['captured_at']}  ({argv[1]})")
        print(f"升级后快照：{after['captured_at']}  ({argv[2]})")
        print()
        diff(before, after)
        assert_outcomes(after)
    elif len(argv) == 2:
        after = load(argv[1])
        print(f"升级后快照：{after['captured_at']}  ({argv[1]})")
        print("没有升级前快照，只校验该做的有没有做，不校验有没有破坏既有数据。")
        print()
        assert_outcomes(after)
    else:
        sys.exit(__doc__)

    if notes:
        print("预期内的追加性改动：")
        for item in notes:
            print(f"  + {item}")
        print()
    if missing:
        print("该做而没做：")
        for item in missing:
            print(f"  ! {item}")
        print()
    if breaks:
        print("违约——既有数据被改动：")
        for item in breaks:
            print(f"  × {item}")
        print()

    if breaks or missing:
        print(f"不通过：{len(breaks)} 项违约，{len(missing)} 项缺失。不要继续，按手册第 8 步回滚。")
        return 1
    print("通过：既有数据一字未动，该做的都做了。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
