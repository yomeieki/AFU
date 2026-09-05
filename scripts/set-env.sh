#!/usr/bin/env bash
# 安全地往生产 .env 写入一个配置项。
#
# 为什么要有这个脚本：直接 vim 生产 .env 容易漏引号/写错键名/写重复键（dotenv 后者覆盖
# 前者，症状极难排查）。密钥类的值也不该出现在 shell 历史或 `ps` 的命令行里。
#
# 用法：
#   bash scripts/set-env.sh WECHAT_PAY_API_V3_KEY     # 输入不回显（密钥用这个）
#   bash scripts/set-env.sh COS_BASE_URL --show       # 输入回显（非敏感值方便核对）
#   bash scripts/set-env.sh --list                    # 只列键与是否已填，不显示任何值
#
# 改完记得重启：pm2 restart food-shop-server（dotenv 只在进程启动时读一次）

set -euo pipefail

ENV_FILE="${ENV_FILE:-/www/food-shop/apps/server/.env}"

[[ -f "${ENV_FILE}" ]] || { echo "找不到 ${ENV_FILE}（可用 ENV_FILE=... 覆盖路径）"; exit 1; }

# ── --list：体检模式，只看键名与填没填 ───────────────────────────────────────
if [[ "${1:-}" == "--list" ]]; then
  echo "配置文件：${ENV_FILE}"
  dup=""
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    v="${v%\"}"; v="${v#\"}"
    if [[ -n "${v}" ]]; then echo "  ✔ ${k}"; else echo "  ○ ${k}  (空)"; fi
    dup="${dup}${k}"$'\n'
  done < "${ENV_FILE}"
  echo "── 重复键检查 ──"
  d="$(printf '%s' "${dup}" | sort | uniq -d)"
  [[ -z "${d}" ]] && echo "  无重复" || { echo "  ⚠ 存在重复键（dotenv 只认最后一条）："; printf '    %s\n' ${d}; }
  exit 0
fi

KEY="${1:-}"
[[ -n "${KEY}" ]] || { echo "用法：$0 <KEY> [--show] | $0 --list"; exit 1; }
[[ "${KEY}" =~ ^[A-Z0-9_]+$ ]] || { echo "键名只能是大写字母/数字/下划线：${KEY}"; exit 1; }

# 读取值
if [[ "${2:-}" == "--show" ]]; then
  read -r -p "请输入 ${KEY} 的值：" VAL
else
  read -r -s -p "请输入 ${KEY} 的值（不回显，粘贴后直接回车）：" VAL
  echo
fi

[[ -n "${VAL}" ]] || { echo "值为空，未做任何修改。"; exit 1; }
# 双引号会破坏 .env 的引号包裹；换行同理
case "${VAL}" in
  *'"'*) echo "值中不能包含双引号。"; exit 1 ;;
esac

# ── 就地替换（键名精确匹配，避免 WECHAT_PAY_API_V3_KEY 这类含数字的键漏配）──
BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d_%H%M%S)"
cp "${ENV_FILE}" "${BACKUP}"
# cp 不保证带过权限位（实测出现过 644），备份与 .env 同样是全量密钥，必须立即收紧
chmod 600 "${BACKUP}"

TMP="$(mktemp)"
chmod 600 "${TMP}"
FOUND=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  if [[ "${line}" =~ ^${KEY}= ]]; then
    if [[ ${FOUND} -eq 0 ]]; then
      printf '%s="%s"\n' "${KEY}" "${VAL}" >> "${TMP}"
      FOUND=1
    fi   # 已存在的重复行直接丢弃，顺手去重
  else
    printf '%s\n' "${line}" >> "${TMP}"
  fi
done < "${ENV_FILE}"
[[ ${FOUND} -eq 1 ]] || printf '%s="%s"\n' "${KEY}" "${VAL}" >> "${TMP}"

mv "${TMP}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "已写入 ${KEY}（${#VAL} 个字符），备份：${BACKUP}"
echo "生效需重启：pm2 restart food-shop-server"
