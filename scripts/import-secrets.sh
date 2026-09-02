#!/usr/bin/env bash
# 从一个「KEY=值」清单文件批量导入到生产 .env，然后安全删除该清单。
#
# 存在的意义：让不熟悉命令行的人可以在图形编辑器里一次填完所有密钥，
# 而导入过程不会把密钥打印到终端（只汇报键名与字符数）。
#
# 用法：
#   bash scripts/import-secrets.sh /tmp/afu-secrets.txt
#   KEEP=1 bash scripts/import-secrets.sh /tmp/afu-secrets.txt   # 导入后保留源文件
#
# 规则：
#   - 以 # 开头的行、空行、值为空的行 一律跳过
#   - 键名必须是 [A-Z0-9_]+，其余行报错跳过
#   - 值两侧的空白与成对引号会被去掉（防止从编辑器复制时带进来）
#   - 同名键只保留一条（顺手去重，dotenv 只认最后一条，重复很难排查）

set -euo pipefail

SRC="${1:-}"
ENV_FILE="${ENV_FILE:-/www/food-shop/apps/server/.env}"
KEEP="${KEEP:-0}"
# 这些键只作说明用途，不写进 .env
NOTE_ONLY_KEYS="${NOTE_ONLY_KEYS:-API_SECURITY_MODE PUBKEY_DOWNLOADED NOTE REMARK}"

[[ -n "${SRC}" ]] || { echo "用法：$0 <清单文件>"; exit 1; }
[[ -f "${SRC}" ]] || { echo "找不到清单文件：${SRC}"; exit 1; }
[[ -f "${ENV_FILE}" ]] || { echo "找不到 ${ENV_FILE}"; exit 1; }

BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d_%H%M%S)"
cp "${ENV_FILE}" "${BACKUP}"

IMPORTED=()
SKIPPED=()
NOTES=()

while IFS= read -r line || [[ -n "${line}" ]]; do
  # 去掉行首尾空白
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "${line}" ]] && continue
  [[ "${line}" == \#* ]] && continue
  [[ "${line}" == *=* ]] || continue

  key="${line%%=*}"
  val="${line#*=}"
  # 去掉值两侧空白
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  # 去掉成对引号（编辑器复制常带）
  [[ "${val}" == \"*\" ]] && val="${val:1:${#val}-2}"
  [[ "${val}" == \'*\' ]] && val="${val:1:${#val}-2}"

  if [[ ! "${key}" =~ ^[A-Z0-9_]+$ ]]; then
    SKIPPED+=("${key}（键名不合法）")
    continue
  fi
  if [[ -z "${val}" ]]; then
    SKIPPED+=("${key}（留空）")
    continue
  fi
  # 说明性字段：只记录、不写入 .env（清单里用来跟操作者沟通的行）
  case " ${NOTE_ONLY_KEYS} " in
    *" ${key} "*) NOTES+=("${key} = ${val}"); continue ;;
  esac
  case "${val}" in *'"'*) SKIPPED+=("${key}（值里有双引号）"); continue ;; esac

  # 微信支付公钥 ID：商户平台上显示为 PUB_KEY_ID_xxxx，很多人只复制了后面的数字。
  # 回调头 Wechatpay-Serial 传来的是带前缀的完整串，缺前缀会导致验签比对失败。
  if [[ "${key}" == "WECHAT_PAY_PUBLIC_KEY_ID" && "${val}" != PUB_KEY_ID_* ]]; then
    val="PUB_KEY_ID_${val}"
    NOTES+=("WECHAT_PAY_PUBLIC_KEY_ID 缺少 PUB_KEY_ID_ 前缀，已自动补上")
  fi

  # 写入 .env（键名精确匹配 + 顺手去重）
  TMP="$(mktemp)"; chmod 600 "${TMP}"
  FOUND=0
  while IFS= read -r l || [[ -n "${l}" ]]; do
    if [[ "${l}" =~ ^${key}= ]]; then
      [[ ${FOUND} -eq 0 ]] && { printf '%s="%s"\n' "${key}" "${val}" >> "${TMP}"; FOUND=1; }
    else
      printf '%s\n' "${l}" >> "${TMP}"
    fi
  done < "${ENV_FILE}"
  [[ ${FOUND} -eq 1 ]] || printf '%s="%s"\n' "${key}" "${val}" >> "${TMP}"
  mv "${TMP}" "${ENV_FILE}"

  IMPORTED+=("${key}（${#val} 字符）")
done < "${SRC}"

chmod 600 "${ENV_FILE}"

echo "已导入 ${#IMPORTED[@]} 项："
for i in "${IMPORTED[@]:-}"; do [[ -n "$i" ]] && echo "  ✔ $i"; done
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo "跳过 ${#SKIPPED[@]} 项："
  for i in "${SKIPPED[@]}"; do echo "  ○ $i"; done
fi
if [[ ${#NOTES[@]} -gt 0 ]]; then
  echo "备注："
  for i in "${NOTES[@]}"; do echo "  · $i"; done
fi
echo "备份：${BACKUP}"

# 安全删除清单文件 —— 只有确实导入到内容时才删。
# （踩过的坑：编辑器里填了但没保存，读到空文件却把源文件删了，等于毁掉对方的输入。）
if [[ ${#IMPORTED[@]} -eq 0 ]]; then
  echo "⚠ 没有导入到任何值，清单文件已保留：${SRC}"
  echo "  多半是编辑器里没保存（Cmd+S），保存后重新执行本命令即可。"
  exit 2
fi
if [[ "${KEEP}" != "1" ]]; then
  if command -v shred &>/dev/null; then shred -u "${SRC}" 2>/dev/null || rm -f "${SRC}"
  else rm -f "${SRC}"; fi
  echo "清单文件已抹除：${SRC}"
else
  echo "清单文件已保留（KEEP=1）：${SRC}"
fi

echo "生效需重启：pm2 restart food-shop-server"
