# TikTokZoomerOkBot

Telegram-бот для скачивания видео и аудио с YouTube, TikTok и других платформ.

## Как это работает

```
Telegram серверы
      ↓ MTProto (исходящее соединение с VPS)
Local Telegram Bot API  (Docker-контейнер, порт 8081)
      ↓ webhook  http://bot:3000  (Docker-сеть, без интернета)
Node.js бот             (Docker-контейнер, порт 3000)
```

- Оба сервиса общаются **внутри Docker-сети** `bot-network` — в интернет трафик не выходит
- nginx проксирует внешний HTTPS на Bot API (`api-telegram.duckdns.org` → `127.0.0.1:8081`) — нужен только для внешнего доступа к Bot API
- Бот стартует только после того как Bot API прошёл healthcheck (`depends_on: condition: service_healthy`)

## Структура на VPS

```
/home/deployer/
  tiktok-zoomer-ok-bot/     ← этот репозиторий
    Dockerfile
    docker-compose.yml
  telegram-bot-api/          ← исходники Local Bot API (отдельный репо)
  data/                      ← данные, не в git
    .env.production.local
    cookies.txt
    bot-files/               ← файлы Telegram Bot API (volume)
    logs/                    ← логи бота (volume)
```

## Переменные окружения

| Файл | Когда используется |
|---|---|
| `.env` | Локальная разработка (long polling) |
| `.env.production.local` | Production на VPS (не в git) |

```env
TELEGRAM_TOKEN=         # токен от BotFather
TELEGRAM_API_ID=        # с my.telegram.org
TELEGRAM_API_HASH=      # с my.telegram.org
TELEGRAM_API_URL=       # локально: https://api-telegram.duckdns.org
                        # прод:     http://telegram-bot-api:8081
TELEGRAM_WEBHOOK_URL=   # локально: https://api-telegram.duckdns.org
                        # прод:     http://bot:3000
ADMIN_ID=               # Telegram user ID администратора
BOT_USERNAME=           # username бота без @
MAX_VIDEO_DURATION_MIN= # максимальная длина видео в минутах
```

## Локальная разработка

```bash
pnpm install
pnpm dev   # long polling, webhook не нужен
```

---

## Production (VPS)

### Первый деплой

```bash
# 1. Клонировать репозиторий (на VPS от пользователя deployer)
git clone git@github.com:Ibadichan/save-yt-media-bot.git /home/deployer/tiktok-zoomer-ok-bot

# 2. Создать папку для данных
mkdir -p /home/deployer/data/{bot-files,logs}

# 3. Скопировать секреты (с локальной машины)
scp .env.production.local deployer@89.167.118.114:/home/deployer/data/.env.production.local
scp cookies.txt deployer@89.167.118.114:/home/deployer/data/cookies.txt

# 4. Собрать и запустить (собирается и бот, и telegram-bot-api из исходников)
cd /home/deployer/tiktok-zoomer-ok-bot
docker compose up -d --build
```

### Редеплой после изменений в боте

```bash
cd /home/deployer/tiktok-zoomer-ok-bot
git pull
docker compose build bot
docker compose up -d bot
```

### Обновить cookies.txt

```bash
# С локальной машины:
scp cookies.txt deployer@89.167.118.114:/home/deployer/data/cookies.txt

# cookies.txt монтируется как volume — перезапуск не нужен.
# Если хочешь убедиться что подхватилось:
docker compose restart bot
```

### Обновить .env.production.local

```bash
# С локальной машины:
scp .env.production.local deployer@89.167.118.114:/home/deployer/data/.env.production.local

# Перезапустить бота чтобы подхватил новые переменные:
cd /home/deployer/tiktok-zoomer-ok-bot
docker compose up -d bot
```

### Полезные команды

```bash
# Статус контейнеров
docker compose ps

# Логи бота (live)
docker compose logs -f bot

# Логи Bot API (live)
docker compose logs -f telegram-bot-api

# Перезапустить всё
docker compose restart

# Остановить всё
docker compose down
```
