#!/usr/bin/env bash
# 文件范围检查：对照授权范围、禁止修改清单和高风险路径清单。
#
# 用法：
#   BASE=<任务开始时的提交> LEVEL=<S|M|L> \
#   ALLOW=<授权清单> DENY=<禁止清单> HIGH_RISK=<高风险清单> \
#   ./check-scope.sh
#
# 清单每行一个 glob，* 可跨目录（src/auth/* 匹配其下所有层级）。
# 空行和以 # 开头的行会被忽略。ALLOW 未设置时不检查授权范围（S 级可不提供）。
# 请在仓库根目录运行；HIGH_RISK 若是仓库内路径，按 BASE 版本读取。
# 每个任务的 ALLOW/DENY 清单应放在仓库外或已被 .gitignore 忽略的位置，
# 否则清单文件本身会被算作改动。
#
# 退出码：0 通过；1 存在越界、禁止修改或需升级为 L 的改动。
set -euo pipefail

: "${BASE:?需要设置 BASE（任务开始时的提交）}"
: "${LEVEL:?需要设置 LEVEL（S/M/L）}"
case "$LEVEL" in S|M|L) ;; *) echo "LEVEL 必须是 S、M 或 L" >&2; exit 2 ;; esac

# matches <文件> <清单>：命中时输出匹配的规则并返回 0
matches() {
  local f="$1" list="$2" p
  [[ -n "$list" && -f "$list" ]] || return 1
  while IFS= read -r p || [[ -n "$p" ]]; do
    p="${p%$'\r'}"
    [[ -z "$p" || "$p" == \#* ]] && continue
    # shellcheck disable=SC2053  # 这里需要 glob 匹配，故意不加引号
    if [[ "$f" == $p ]]; then echo "$p"; return 0; fi
  done < "$list"
  return 1
}

# 高风险清单若在仓库中，按 BASE 版本读取，防止本次任务改清单来绕过检查
risk_list="${HIGH_RISK:-}"
if [[ -n "$risk_list" ]] && git cat-file -e "$BASE:$risk_list" 2>/dev/null; then
  risk_tmp=$(mktemp)
  trap 'rm -f "$risk_tmp"' EXIT
  git show "$BASE:$risk_list" > "$risk_tmp"
  risk_list="$risk_tmp"
fi

# 已跟踪文件的改动（含已提交、已暂存、未暂存；重命名拆成删除+新增）
# 加上未跟踪的新文件
changed=$(
  {
    git -c core.quotePath=false diff --name-only --no-renames "$BASE"
    git -c core.quotePath=false ls-files --others --exclude-standard
  } | sort -u
)

fail=0
count=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  count=$((count + 1))
  if rule=$(matches "$f" "${DENY:-}"); then
    echo "✗ 禁止修改：$f（规则：$rule）"; fail=1
  fi
  if [[ -n "${ALLOW:-}" ]] && ! matches "$f" "$ALLOW" >/dev/null; then
    echo "✗ 超出授权范围：$f"; fail=1
  fi
  if [[ "$LEVEL" != "L" ]] && rule=$(matches "$f" "$risk_list"); then
    echo "✗ 命中高风险路径，需升级为 L：$f（规则：$rule）"; fail=1
  fi
done <<< "$changed"

if [[ $fail -eq 0 ]]; then
  echo "✓ 文件范围检查通过（等级 $LEVEL，改动 $count 个文件）"
fi
exit "$fail"
