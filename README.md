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



## Установка одной командой (Docker или системная установка — определяется сам)

Скрипт сам понимает, как у тебя установлен n8n:

1. Сначала ищет Docker-контейнер (по имени образа `n8nio/n8n` / `docker.n8n.io/n8nio/n8n`,
   при необходимости — по имени контейнера, содержащему "n8n") и проверяет, что внутри
   контейнера действительно есть бинарник `n8n`.
2. Если Docker не используется или контейнер не нашёлся — проверяет системную
   установку: команду `n8n` в PATH, запущенный процесс `n8n`, или systemd-сервис
   с именем, содержащим "n8n".
3. В зависимости от найденного режима либо собирает пакет во временном
   `node:20-alpine` контейнере и кладёт его в `/home/node/.n8n/custom/` внутри
   Docker-контейнера, либо собирает локальным `npm` и кладёт в
   `$N8N_USER_FOLDER/custom` (по умолчанию `~/.n8n/custom`) на хосте.

```bash
curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash
```

Если на сервере несколько Docker-контейнеров, подходящих под критерии — скрипт
не будет гадать, выведет список и попросит указать нужный явно:

```bash
curl -fsSL https://raw.githubusercontent.com/OneDimon/n8n-nodes-gemini-proxy/main/install.sh | bash -s -- <имя_контейнера>
```

После установки в поиске нод в n8n UI появится **"Gemini Chat Model (Proxy)"**.

⚠️ В Docker-режиме скрипт делает `docker restart` — это оборвёт текущие выполняющиеся
workflow. В системном режиме — `systemctl restart n8n`, если такой сервис найден;
иначе попросит перезапустить n8n вручную.

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
   - Use Proxy — включи (это переключатель внутри credential, не убирался)
   - Proxy URL — `socks5://127.0.0.1:1080` (твой WARP socks5) либо `http://...`
3. Подключи эту ноду как Chat Model к своей AI Agent ноде так же, как обычную
   Google Gemini Chat Model.

### Автоопределение адреса прокси в Docker

Если в Proxy URL указан `127.0.0.1` / `localhost` — нода это сама знает не сработает
напрямую внутри контейнера (контейнеры изолированы от localhost хоста) и **перед
первым запросом сама пробует** несколько типичных вариантов, в этом порядке:

1. адрес как есть (вдруг n8n всё-таки не в контейнере);
2. `host.docker.internal` (часто работает в Docker Desktop / при настроенном `extra_hosts`);
3. реальный gateway-адрес Docker-моста, прочитанный из `/proc/net/route` внутри контейнера;
4. `172.17.0.1` (типичный дефолтный gateway моста `bridge` в Linux).

Первый адрес, к которому реально получилось подключиться по TCP — используется.
Если ни один не отозвался — нода всё равно попробует исходный адрес, чтобы ошибка
в логе осталась осмысленной (а не "везде не достучался").

Руками ничего прописывать не нужно — просто оставь Proxy URL как есть с `127.0.0.1`.

## 4. Известные упрощения (на стадии MVP, не для прода)

- Tool calling реализован (`bindTools` + `functionCall`/`functionResponse`),
  но не покрыт тестами на сложных многошаговых / параллельных вызовах инструментов.
- Ретраи с экспоненциальным backoff реализованы для 429/500/502/503/504
  (макс. 3 повтора, задержка 1с → 2с → 4с). Ошибки авторизации (401/403) и
  валидации (400) не ретраятся — сразу падают с понятным сообщением.
- Понятные сообщения об ошибках вместо сырого стектрейса: неверный ключ,
  превышен лимит, прокси недоступен (ECONNREFUSED), таймаут.
- Нет streaming (`streamGenerateContent`) — только обычный `generateContent`.

Если после локального теста всё ок — можно постепенно дотягивать до полноценной
ноды (streaming, более тонкая обработка multi-tool сценариев) и уже потом думать
про публикацию в npm / подачу на Verified Community Nodes.
