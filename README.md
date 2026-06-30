# n8n-nodes-gemini-proxy

## Зачем это нужно

Официальная нода **Google Gemini Chat Model** в n8n использует `@google/generative-ai`
SDK от Google, который не уважает `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` ни как
env-переменные, ни как параметр Host в credential. Это подтверждённые открытые баги
самого n8n:

- [n8n-io/n8n#19516](https://github.com/n8n-io/n8n/issues/19516) — Gemini Model not respecting proxy settings
- [n8n-io/n8n#17495](https://github.com/n8n-io/n8n/issues/17495) — RSS and Gemini Model module is not using proxy
- [n8n-io/n8n#18338](https://github.com/n8n-io/n8n/issues/18338) — Google Gemini node doesn't use custom host provided in credential

При этом обычная **HTTP Request** нода прокси уважает нормально (через axios/got),
что и натолкнуло на решение: переписать Chat Model ноду так, чтобы она делала
прямые REST-запросы к `generativelanguage.googleapis.com` через `axios` с явным
`https-proxy-agent`/`socks-proxy-agent`, вместо непрозрачного Google SDK.

## Статус

MVP для локального теста на собственном n8n. Не опубликовано в npm registry,
не подавалось на n8n Verified Community Nodes — сознательно, по решению автора,
до тестирования в бою.



## Установка одной командой (Docker)

Скрипт сам найдёт запущенный контейнер с n8n (по имени образа `n8nio/n8n`, а если
не найдёт — по имени/команде, содержащей "n8n"), проверит, что внутри
действительно есть бинарник `n8n` (чтобы случайно не залезть не в тот контейнер),
и только после этого начнёт установку:

```bash
curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash
```

Если на сервере несколько контейнеров, подходящих под критерии (например, тестовый
и боевой n8n) — скрипт не будет гадать, а выведет список и попросит указать имя
явно вторым аргументом:

```bash
curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>
```

Скрипт сам: находит контейнер → клонирует репозиторий → ставит зависимости →
собирает TypeScript в JS → копирует результат в `/home/node/.n8n/custom/` внутри
контейнера → ставит туда рантайм-зависимости (axios, proxy-agent) → перезапускает
контейнер.

После этого в поиске нод в n8n UI появится **"Gemini Chat Model (Proxy)"** — ничего
руками собирать не нужно.

⚠️ Имей в виду: `docker restart` оборвёт все текущие выполняющиеся workflow в этот момент.

## Установка вручную (по шагам)

## 1. Установка зависимостей и сборка (на твоём VPS или локально)

```bash
cd n8n-nodes-gemini-proxy
npm install
npm run build
```

Это создаст папку `dist/` со скомпилированным JS.

## 2. Подключение к локальному n8n (Docker)

Если n8n у тебя в Docker с volume на `~/.n8n`, проще всего смонтировать собранный
пакет как custom-ноду:

```bash
mkdir -p ~/.n8n/custom
cp -r dist/nodes ~/.n8n/custom/
cp -r dist/credentials ~/.n8n/custom/
# нужен package.json внутри custom/, иначе n8n не подхватит зависимости (axios, agents)
cp package.json ~/.n8n/custom/
cd ~/.n8n/custom && npm install --omit=dev
```

Либо (чище) — установи как community-ноду без публикации в npm registry, упаковав
через `npm pack` и поставив локальный tarball:

```bash
npm pack            # создаст n8n-nodes-gemini-proxy-0.1.0.tgz
# в контейнере n8n:
docker cp n8n-nodes-gemini-proxy-0.1.0.tgz <container>:/tmp/
docker exec -it <container> sh -c "cd /home/node/.n8n/nodes && npm install /tmp/n8n-nodes-gemini-proxy-0.1.0.tgz"
```

После этого — **перезапусти контейнер n8n**, чтобы он пересканировал ноды:
```bash
docker restart <container>
```

## 3. Настройка в UI

1. Settings → нода не появится в community nodes (она приватная), а будет
   доступна сразу в поиске нод как **"Gemini Chat Model (Proxy)"**.
2. Создай Credential **"Gemini (Proxy-aware) API"**:
   - API Key — твой ключ от Google AI Studio
   - Base URL — оставь дефолтный, если не используешь reverse-proxy
   - Use Proxy — включи
   - Proxy URL — `socks5://127.0.0.1:1080` (твой WARP socks5) либо `http://...`
3. Подключи эту ноду как Chat Model к своей AI Agent ноде так же, как обычную
   Google Gemini Chat Model.

## 4. Известные упрощения (на стадии MVP, не для прода)

- Нет streaming (`streamGenerateContent`) — только обычный `generateContent`.
- История переписки сворачивается в простую user/model последовательность,
  без полноценной поддержки multi-turn function calling / tool calls.
- Нет автоматического маппинга ошибок Google API в человекочитаемые сообщения n8n.
- Нет ретраев/backoff при 429.

Если после локального теста всё ок — можно постепенно дотягивать до полноценной
ноды (tool calling, streaming, retries) и уже потом думать про публикацию в npm /
подачу на Verified Community Nodes.
