#!/usr/bin/env bash
# Установка n8n-nodes-gemini-proxy одной командой на сервере с n8n в Docker.
#
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера_n8n>
#
# Пример:
#   curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- n8n
#
# Если N8N_CUSTOM_DIR не задан (т.е. ~/.n8n не смонтирован с хоста в контейнер),
# скрипт соберёт пакет и скопирует его файлы прямо внутрь работающего контейнера,
# затем перезапустит его.

set -euo pipefail

CONTAINER_NAME="${1:-n8n}"
REPO_URL="https://github.com/OneDimon/n8n-nodes-gemini-proxy.git"
TMP_DIR="$(mktemp -d)"

echo "==> Клонирую репозиторий..."
git clone --depth 1 "$REPO_URL" "$TMP_DIR/n8n-nodes-gemini-proxy"
cd "$TMP_DIR/n8n-nodes-gemini-proxy"

echo "==> Устанавливаю зависимости и собираю..."
npm install --no-audit --no-fund
npm run build

echo "==> Копирую иконку рядом со скомпилированной нодой..."
mkdir -p dist/nodes/LmChatGeminiProxy
cp nodes/LmChatGeminiProxy/gemini.svg dist/nodes/LmChatGeminiProxy/

echo "==> Копирую package.json (нужен внутри custom/ для зависимостей рантайма)..."
cp package.json dist/

echo "==> Проверяю наличие контейнера '$CONTAINER_NAME'..."
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Контейнер '$CONTAINER_NAME' не найден среди запущенных. Доступные контейнеры:"
  docker ps --format '{{.Names}}'
  exit 1
fi

echo "==> Создаю директорию custom внутри контейнера..."
docker exec "$CONTAINER_NAME" mkdir -p /home/node/.n8n/custom

echo "==> Копирую файлы в контейнер..."
docker cp dist/. "$CONTAINER_NAME":/home/node/.n8n/custom/

echo "==> Устанавливаю runtime-зависимости (axios, proxy-agent) внутри контейнера..."
docker exec "$CONTAINER_NAME" sh -c "cd /home/node/.n8n/custom && npm install --omit=dev --no-audit --no-fund"

echo "==> Перезапускаю контейнер..."
docker restart "$CONTAINER_NAME"

echo "==> Готово. Открой n8n, в поиске нод введи 'Gemini Chat Model (Proxy)'."
rm -rf "$TMP_DIR"
