#!/usr/bin/env bash
# Установка n8n-nodes-gemini-proxy одной командой на сервере с n8n в Docker.
#
# Использование (полностью автоматическое, контейнер ищется сам):
#   curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash
#
# Если контейнеров несколько или автоопределение не сработало, можно указать
# имя явно вторым способом:
#   curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>

set -euo pipefail

REPO_URL="https://github.com/OneDimon/n8n-nodes-gemini-proxy.git"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Ищу контейнер с n8n..."

CONTAINER_NAME="${1:-}"

if [ -z "$CONTAINER_NAME" ]; then
  # 1. Сначала пытаемся найти по образу (надёжнее всего: n8nio/n8n или docker.n8n.io/n8nio/n8n)
  CANDIDATES="$(docker ps --filter "ancestor=n8nio/n8n" --filter "ancestor=docker.n8n.io/n8nio/n8n" --format '{{.Names}}' | sort -u)"

  # 2. Если по образу ничего не нашли — пробуем по имени/команде содержащей "n8n"
  if [ -z "$CANDIDATES" ]; then
    CANDIDATES="$(docker ps --format '{{.Names}}\t{{.Image}}' | grep -i 'n8n' | cut -f1 | sort -u)"
  fi

  COUNT="$(echo "$CANDIDATES" | grep -c . || true)"

  if [ "$COUNT" -eq 0 ]; then
    echo "Не нашёл ни одного запущенного контейнера с n8n."
    echo "Список всех запущенных контейнеров:"
    docker ps --format '  - {{.Names}} ({{.Image}})'
    echo ""
    echo "Укажи имя контейнера явно:"
    echo "  curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>"
    exit 1
  elif [ "$COUNT" -gt 1 ]; then
    echo "Нашёл несколько подходящих контейнеров, не могу выбрать автоматически:"
    echo "$CANDIDATES" | sed 's/^/  - /'
    echo ""
    echo "Укажи нужный явно:"
    echo "  curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>"
    exit 1
  fi

  CONTAINER_NAME="$CANDIDATES"
  echo "==> Найден контейнер: $CONTAINER_NAME"
fi

echo "==> Проверяю, что контейнер '$CONTAINER_NAME' запущен и это действительно n8n..."

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Контейнер '$CONTAINER_NAME' не найден среди запущенных. Доступные контейнеры:"
  docker ps --format '  - {{.Names}} ({{.Image}})'
  exit 1
fi

# Проверка "это действительно n8n": внутри контейнера должен существовать бинарник n8n
if ! docker exec "$CONTAINER_NAME" sh -c 'command -v n8n' >/dev/null 2>&1; then
  echo "Контейнер '$CONTAINER_NAME' запущен, но внутри не нашёл бинарник 'n8n'."
  echo "Похоже, это не n8n-контейнер. Прерываю установку, чтобы не сломать что-то чужое."
  exit 1
fi

echo "==> Подтверждено: '$CONTAINER_NAME' — рабочий контейнер n8n."

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

echo "==> Создаю директорию custom внутри контейнера..."
docker exec "$CONTAINER_NAME" mkdir -p /home/node/.n8n/custom

echo "==> Копирую файлы в контейнер..."
docker cp dist/. "$CONTAINER_NAME":/home/node/.n8n/custom/

echo "==> Устанавливаю runtime-зависимости (axios, proxy-agent) внутри контейнера..."
docker exec "$CONTAINER_NAME" sh -c "cd /home/node/.n8n/custom && npm install --omit=dev --no-audit --no-fund"

echo "==> Перезапускаю контейнер..."
docker restart "$CONTAINER_NAME"

echo "==> Готово. Открой n8n, в поиске нод введи 'Gemini Chat Model (Proxy)'."
