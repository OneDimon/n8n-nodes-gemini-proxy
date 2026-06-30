#!/usr/bin/env bash
# Установка n8n-nodes-gemini-proxy одной командой.
# Скрипт сам определяет, как у тебя установлен n8n — в Docker или системно
# (npm install -g / systemd-сервис) — и ставит ноду подходящим способом.
#
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash
#
# Если контейнеров несколько и автоопределение не справилось — можно явно
# указать имя Docker-контейнера вторым аргументом:
#   curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>

set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "Не найден 'git' на хосте. Установи его и запусти скрипт заново."
  exit 1
fi

REPO_URL="https://github.com/OneDimon/n8n-nodes-gemini-proxy.git"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
EXPLICIT_CONTAINER="${1:-}"
MODE=""
CONTAINER_NAME=""

echo "==> Определяю, как у тебя установлен n8n (Docker или системно)..."

# ---------- Попытка №1: Docker ----------
if command -v docker >/dev/null 2>&1; then
  if [ -n "$EXPLICIT_CONTAINER" ]; then
    if docker ps --format '{{.Names}}' | grep -qx "$EXPLICIT_CONTAINER"; then
      CONTAINER_NAME="$EXPLICIT_CONTAINER"
      MODE="docker"
    fi
  else
    CANDIDATES="$(docker ps --filter "ancestor=n8nio/n8n" --filter "ancestor=docker.n8n.io/n8nio/n8n" --format '{{.Names}}' 2>/dev/null | sort -u)"
    if [ -z "$CANDIDATES" ]; then
      CANDIDATES="$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i 'n8n' | cut -f1 | sort -u)"
    fi
    COUNT="$(echo "$CANDIDATES" | grep -c . || true)"
    if [ "$COUNT" -eq 1 ]; then
      CONTAINER_NAME="$CANDIDATES"
      MODE="docker"
    elif [ "$COUNT" -gt 1 ]; then
      echo "Нашёл несколько Docker-контейнеров с n8n, не могу выбрать автоматически:"
      echo "$CANDIDATES" | sed 's/^/  - /'
      echo ""
      echo "Укажи нужный явно:"
      echo "  curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>"
      exit 1
    fi
  fi

  if [ -n "$CONTAINER_NAME" ]; then
    # Подтверждаем, что внутри контейнера правда есть бинарник n8n
    if ! docker exec "$CONTAINER_NAME" sh -c 'command -v n8n' >/dev/null 2>&1; then
      echo "Контейнер '$CONTAINER_NAME' найден, но внутри нет бинарника 'n8n'. Похоже, это не тот контейнер."
      CONTAINER_NAME=""
      MODE=""
    fi
  fi
fi

# ---------- Попытка №2: системная установка (npm -g / systemd) ----------
if [ -z "$MODE" ]; then
  if command -v n8n >/dev/null 2>&1; then
    MODE="system"
  elif pgrep -x n8n >/dev/null 2>&1; then
    MODE="system"
  elif systemctl list-units --type=service --all 2>/dev/null | grep -qi 'n8n'; then
    MODE="system"
  fi
fi

if [ -z "$MODE" ]; then
  echo "Не нашёл n8n ни в Docker, ни как системную установку."
  if command -v docker >/dev/null 2>&1; then
    echo "Запущенные Docker-контейнеры:"
    docker ps --format '  - {{.Names}} ({{.Image}})'
  fi
  echo "Если n8n всё же запущен, укажи Docker-контейнер явно:"
  echo "  curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>"
  exit 1
fi

echo "==> Режим установки: $MODE${CONTAINER_NAME:+ (контейнер: $CONTAINER_NAME)}"

echo "==> Клонирую репозиторий..."
git clone --depth 1 "$REPO_URL" "$TMP_DIR/n8n-nodes-gemini-proxy"
cd "$TMP_DIR/n8n-nodes-gemini-proxy"

if [ "$MODE" = "docker" ]; then
  echo "==> Собираю пакет внутри временного контейнера node:20-alpine (на хосте npm не нужен)..."
  docker run --rm \
    -v "$TMP_DIR/n8n-nodes-gemini-proxy:/work" \
    -w /work \
    node:20-alpine \
    sh -c "npm install --no-audit --no-fund && npm run build"
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "Системная установка n8n найдена, но на хосте нет npm — собрать пакет нечем."
    exit 1
  fi
  echo "==> Собираю пакет локальным npm (системный режим)..."
  npm install --no-audit --no-fund
  npm run build
fi

mkdir -p dist/nodes/LmChatGeminiProxy
cp nodes/LmChatGeminiProxy/gemini.svg dist/nodes/LmChatGeminiProxy/
cp package.json dist/

if [ "$MODE" = "docker" ]; then
  echo "==> Копирую файлы в контейнер '$CONTAINER_NAME'..."
  docker exec "$CONTAINER_NAME" mkdir -p /home/node/.n8n/custom
  docker cp dist/. "$CONTAINER_NAME":/home/node/.n8n/custom/
  echo "==> Устанавливаю runtime-зависимости внутри контейнера..."
  docker exec "$CONTAINER_NAME" sh -c "cd /home/node/.n8n/custom && npm install --omit=dev --no-audit --no-fund"
  echo "==> Перезапускаю контейнер..."
  docker restart "$CONTAINER_NAME"
else
  CUSTOM_DIR="${N8N_USER_FOLDER:-$HOME/.n8n}/custom"
  echo "==> Копирую файлы в '$CUSTOM_DIR' (системная установка)..."
  mkdir -p "$CUSTOM_DIR"
  cp -r dist/. "$CUSTOM_DIR/"
  echo "==> Устанавливаю runtime-зависимости..."
  (cd "$CUSTOM_DIR" && npm install --omit=dev --no-audit --no-fund)

  if systemctl list-units --type=service --all 2>/dev/null | grep -qi '^n8n\.service'; then
    echo "==> Перезапускаю systemd-сервис n8n..."
    systemctl restart n8n
  else
    echo "==> Сервис n8n как systemd-юнит не найден — перезапусти n8n вручную, чтобы нода подхватилась."
  fi
fi

echo "==> Готово. Открой n8n, в поиске нод введи 'Gemini Chat Model (Proxy)'."
