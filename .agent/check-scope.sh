#!/usr/bin/env bash
# 范围检查（协议 §2.5 第 2 步）。用法：
#   BASE=<sha> LEVEL=S|M|L [ALLOW=allow.txt] [DENY=deny.txt] [HIGH_RISK=.agent/high-risk.txt] bash <(git show "<BASE>:.agent/check-scope.sh")
# 输出四种结论之一（可同时出现多条，任一条非「通过」即退出码 1）：
#   需升级为 L：<文件>        —— LEVEL 不是 L，却改了 HIGH_RISK 里的路径
#   禁止修改：<文件>          —— 改了 DENY 里的路径
#   超出授权范围：<文件>      —— LEVEL 为 M/L 且给了 ALLOW，改了 ALLOW 之外的路径
#   范围检查通过（N 个文件）
# 改动集 = git diff --name-only <BASE> ∪ 未跟踪文件（含 .agent 自身）。glob 用 bash case 匹配，* 可跨目录。
set -uo pipefail
: "${BASE:?BASE 必填}"
: "${LEVEL:?LEVEL 必填（S|M|L）}"
case "$LEVEL" in S|M|L) ;; *) echo "LEVEL 只能是 S|M|L，收到 [$LEVEL]"; exit 2;; esac
ALLOW="${ALLOW:-}"; DENY="${DENY:-}"; HIGH_RISK="${HIGH_RISK:-.agent/high-risk.txt}"
git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null || { echo "BASE [$BASE] 不是有效提交"; exit 2; }

changed=$( { git diff --name-only "$BASE" --; git ls-files --others --exclude-standard; } | sed '/^$/d' | sort -u )
matches_any() { # <file> <pattern-file> → 0 命中
  local f=$1 pf=$2 p
  [[ -n "$pf" && -f "$pf" ]] || return 1
  while IFS= read -r p || [[ -n "$p" ]]; do
    p="${p%%#*}"; p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
    [[ -z "$p" ]] && continue
    # shellcheck disable=SC2254
    case "$f" in $p) return 0;; esac
  done < "$pf"
  return 1
}

upgrade=(); denied=(); outside=(); n=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  n=$((n+1))
  if [[ "$LEVEL" != "L" ]] && matches_any "$f" "$HIGH_RISK"; then upgrade+=("$f"); fi
  if matches_any "$f" "$DENY"; then denied+=("$f"); fi
  if [[ "$LEVEL" != "S" && -n "$ALLOW" ]] && ! matches_any "$f" "$ALLOW"; then outside+=("$f"); fi
done <<<"$changed"

rc=0
if ((${#upgrade[@]})); then echo "需升级为 L：${upgrade[*]}"; rc=1; fi
if ((${#denied[@]})); then echo "禁止修改：${denied[*]}"; rc=1; fi
if ((${#outside[@]})); then echo "超出授权范围：${outside[*]}"; rc=1; fi
if ((rc==0)); then echo "范围检查通过（${n} 个文件）"; fi
exit $rc
