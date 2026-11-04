#!/usr/bin/env python3
"""state-diff.py 的自测：证明它既放得过该放的，也拦得住该拦的。

自带合成快照，不需要实例，直接跑：

    python3 deploy/dev/state-diff-test.py

一个只会说"通过"的对账器等于没有。所以这里逐个注入真实的破坏场景，
要求每一个都被拦下——少拦一个就算这份自测失败。
"""

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIFF = HERE / "state-diff.py"

HANDOFF = "交接"
REQUIREMENT_TYPES = ["Task", "Feature", "Bug"]
SHARED = ["需求 ID", "需求提交人", "可见性", "模块", "来源 Session",
          "实际认领 Agent", "认领 Session", "认领标签", "认领时间", "认领范围"]
HANDOFF_FIELDS = ["交接线程", "交接状态", "上一任交接", "期望接手 Agent",
                  "仓库", "分支", "基线提交", "待办总数", "已完成待办"]


def field(fid, fmt="string", types=None, options=None, values=0):
    return {"id": fid, "format": fmt, "multi_value": False, "is_required": False,
            "is_for_all": True, "types": list(types or []), "projects": ["eva-project"],
            "options": list(options or []), "values_present": values}


def build_before():
    fields = {}
    fid = 1
    for name in SHARED:
        fields[name] = field(fid, types=REQUIREMENT_TYPES, values=40)
        fid += 1
    fields["实际认领 Agent"] = field(6, "list", REQUIREMENT_TYPES, ["Codex", "Claude"], 12)
    fields["负责 Agent"] = field(fid, "list", REQUIREMENT_TYPES,
                                 ["Codex", "Claude", "不限", "待确认"], 30)
    fid += 1
    fields["需求状态"] = field(fid, "list", REQUIREMENT_TYPES,
                               ["待确认", "待认领", "进行中", "已完成", "已合并"], 44)
    fid += 1
    while len(fields) < 26:                       # 补到生产实际的 26 个需求字段
        fields[f"需求字段{fid}"] = field(fid, types=REQUIREMENT_TYPES, values=5)
        fid += 1
    return {
        "schema": 1, "captured_at": "2026-09-21T00:00:00Z",
        "instance": {"host_name": "eva-project", "openproject_version": "17.8.0"},
        "work_packages": {"total": 151, "max_id": 151, "digest": "wp-digest",
                          "by_type": {"Task": 100, "Feature": 30, "Bug": 21},
                          "by_status": {"进行中": 40, "已完成": 111},
                          "by_project": {"eva-project": 151}},
        "projects": {"eva-project": {"id": 3, "name": "Eva-Project Requirements",
                                   "active": True, "types": list(REQUIREMENT_TYPES)}},
        "types": {name: {"id": i + 1, "is_default": False, "is_milestone": False,
                         "workflow_count": 75} for i, name in enumerate(REQUIREMENT_TYPES)},
        "statuses": {"进行中": {"id": 1, "is_closed": False},
                     "已完成": {"id": 2, "is_closed": True}},
        "custom_fields": fields,
        "attachments": {"total": 9, "bytes": 123456, "digest": "att-digest"},
        "queries": {"total": 4, "global": ["季度路线图", "我的认领"],
                    "by_project": {"eva-project": 2}},
        "users": {"total": 3, "logins": ["1:", "2:brian", "3:admin"]},
        "members": 2,
        "settings": {"work_package_list_default_columns": ["id", "subject", "type"],
                     "demo_projects_available": False, "boards_demo_data_available": False,
                     "welcome_text_digest": "welcome-digest", "welcome_text_length": 120},
    }


def build_after(before):
    """引导脚本跑完之后该有的样子：只追加，不改动。"""
    a = copy.deepcopy(before)
    a["captured_at"] = "2026-09-21T01:00:00Z"
    a["types"][HANDOFF] = {"id": 8, "is_default": False, "is_milestone": False,
                           "workflow_count": 75}
    a["projects"]["eva-project"]["types"].append(HANDOFF)
    for name in SHARED:
        a["custom_fields"][name]["types"].append(HANDOFF)
    for name in ("负责 Agent", "实际认领 Agent"):
        opts = a["custom_fields"][name]["options"]
        opts.insert(2, "Mila")                    # 插在中间：既有选项相对顺序不变
    for i, name in enumerate(HANDOFF_FIELDS):
        a["custom_fields"][name] = field(100 + i, types=[HANDOFF])
    return a


def run(before, after):
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for name, data in (("before.json", before), ("after.json", after)):
            if data is None:
                continue
            path = Path(tmp) / name
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            paths.append(str(path))
        proc = subprocess.run([sys.executable, str(DIFF), *paths],
                              capture_output=True, text=True)
        return proc.returncode, proc.stdout


def main():
    before = build_before()
    after = build_after(before)
    failures = []

    code, out = run(before, after)
    if code != 0:
        failures.append(("忠实升级应当通过", f"退出码 {code}\n{out}"))
    else:
        print("  ✓ 忠实升级：通过")
    for expected in (f"新增类型：{HANDOFF}", "新增字段：交接线程", "新增选项：['Mila']"):
        if expected not in out:
            failures.append(("预期内改动应当被列出", f"没看到「{expected}」"))

    code, out = run(None, after)
    if code != 0:
        failures.append(("只给升级后快照也该通过", f"退出码 {code}\n{out}"))
    else:
        print("  ✓ 单快照模式：通过")

    def rm(d, k):
        d.pop(k, None)

    breaks = [
        ("字段已填值减少",   lambda a: a["custom_fields"]["需求 ID"].__setitem__("values_present", 1), "已填值减少"),
        ("全局查询被删除",   lambda a: a["queries"]["global"].remove("季度路线图"),                    "全局查询被删除"),
        ("欢迎页被覆盖",     lambda a: a["settings"].__setitem__("welcome_text_digest", "x"),          "欢迎页文本被覆盖"),
        ("字段丢类型绑定",   lambda a: a["custom_fields"]["需求 ID"]["types"].remove("Bug"),           "丢了类型绑定"),
        ("字段 id 被重建",   lambda a: a["custom_fields"]["需求 ID"].__setitem__("id", 999),           "id 变了"),
        ("既有选项被删",     lambda a: a["custom_fields"]["需求状态"]["options"].remove("已合并"),     "丢了选项"),
        ("选项顺序被打乱",   lambda a: a["custom_fields"]["需求状态"]["options"].reverse(),            "相对顺序被打乱"),
        ("既有工作流被削",   lambda a: a["types"]["Task"].__setitem__("workflow_count", 0),            "工作流迁移减少"),
        ("附件减少",         lambda a: a["attachments"].__setitem__("total", 1),                       "附件数 变了"),
        ("附件内容变化",     lambda a: a["attachments"].__setitem__("digest", "x"),                    "附件摘要 变了"),
        ("用户消失",         lambda a: a["users"]["logins"].remove("2:brian"),                         "用户消失"),
        ("项目被归档",       lambda a: a["projects"]["eva-project"].__setitem__("active", False),        "被归档了"),
        ("工作包总数变化",   lambda a: a["work_packages"].__setitem__("total", 150),                   "工作包总数"),
        ("工作包内容被改",   lambda a: a["work_packages"].__setitem__("digest", "x"),                  "内容摘要变了"),
        ("类型消失",         lambda a: rm(a["types"], "Bug"),                                          "类型消失"),
        ("状态消失",         lambda a: rm(a["statuses"], "已完成"),                                    "状态消失"),
        ("字段消失",         lambda a: rm(a["custom_fields"], "认领标签"),                             "自定义字段消失"),
    ]
    misses = [
        ("交接类型没建出来", lambda a: rm(a["types"], HANDOFF),                                        "不存在"),
        ("交接类型没工作流", lambda a: a["types"][HANDOFF].__setitem__("workflow_count", 0),           "422"),
        ("交接字段绑多了",   lambda a: a["custom_fields"]["交接线程"]["types"].append("Task"),         "应当只有"),
        ("共用字段漏绑",     lambda a: a["custom_fields"]["认领范围"]["types"].remove(HANDOFF),        "读不到它"),
        ("枚举漏加 Mila",    lambda a: a["custom_fields"]["负责 Agent"]["options"].remove("Mila"),     "缺少选项"),
        ("交接字段没建出来", lambda a: rm(a["custom_fields"], "基线提交"),                             "交接字段缺失"),
    ]

    for label, mutate, needle in breaks:
        doctored = copy.deepcopy(after)
        mutate(doctored)
        code, out = run(before, doctored)
        if code == 1 and needle in out:
            print(f"  ✓ 拦下：{label}")
        else:
            failures.append((f"没拦下：{label}", f"退出码 {code}，期望正文含「{needle}」\n{out}"))

    for label, mutate, needle in misses:
        doctored = copy.deepcopy(after)
        mutate(doctored)
        code, out = run(None, doctored)
        if code == 1 and needle in out:
            print(f"  ✓ 拦下：{label}")
        else:
            failures.append((f"没拦下：{label}", f"退出码 {code}，期望正文含「{needle}」\n{out}"))

    print()
    if failures:
        for label, detail in failures:
            print(f"✗ {label}\n    {detail}")
        print(f"\n自测不通过：{len(failures)} 项。")
        return 1
    print(f"自测通过：{len(breaks)} 种破坏、{len(misses)} 种遗漏全部拦下，忠实升级放行。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
