#!/usr/bin/env python3
"""检查站内本地链接和资源是否都存在（不联网，外部链接跳过）。

用法：  python tools/check-links.py
退出码：0 全部通过；1 有断链。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ATTR = re.compile(r'(?:href|src)\s*=\s*"([^"]+)"', re.I)
SKIP_PREFIX = ("http://", "https://", "//", "mailto:", "tel:", "data:", "javascript:", "#")

def main():
    problems = []
    pages = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "docs", "tools", ".github")]
        for fn in filenames:
            if not fn.endswith(".html"):
                continue
            pages += 1
            path = os.path.join(dirpath, fn)
            with io_open(path) as fh:
                html = fh.read()
            for raw in ATTR.findall(html):
                target = raw.strip()
                if not target or target.startswith(SKIP_PREFIX):
                    continue
                target = target.split("#")[0].split("?")[0]
                if not target:
                    continue
                resolved = os.path.normpath(os.path.join(dirpath, target))
                if not os.path.exists(resolved):
                    problems.append("%s -> %s" % (os.path.relpath(path, ROOT), raw))
    for p in problems:
        print("BROKEN  " + p)
    print("checked %d pages, %d broken link(s)" % (pages, len(problems)))
    return 1 if problems else 0

def io_open(path):
    import io
    return io.open(path, encoding="utf-8", errors="replace")

if __name__ == "__main__":
    sys.exit(main())
