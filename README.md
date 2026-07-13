# MAX chat moderation bot

Бот удаляет новые сообщения в MAX-чате, если в тексте найден мат. Логика работает с событиями `message_created` и удаляет сообщение через `DELETE /messages`.

## Что нужно в MAX

1. В настройках бота разрешить добавление в групповой чат.
2. Добавить бота в нужный чат.
3. Сделать бота администратором чата.
4. Выдать права, достаточные для чтения всех сообщений и удаления сообщений.

Без прав администратора бот не будет получать события из группового чата, а без права удаления API вернёт ошибку при `DELETE /messages`.

## Первый запуск через Long Polling

Long Polling подходит для разработки и проверки. Для production в документации MAX рекомендуется Webhook.

```powershell
Copy-Item .env.example .env
notepad .env
npm install
npm run check
npm start
```

Для безопасной первой проверки поставьте в `.env`:

```dotenv
DRY_RUN=true
MODERATION_NOTIFY=true
MODERATION_WARNING=Тест: нашёл запрещённое слово "{token}", правило "{reason}". Пока DRY_RUN=true, сообщение не удаляю.
```

Так бот будет писать в консоль, какие сообщения он удалил бы, но не будет вызывать удаление.

Для боевого режима:

```dotenv
DRY_RUN=false
MODERATION_NOTIFY=true
MODERATION_WARNING={user}, ваше сообщение удалено: в чате запрещена ненормативная лексика. Давайте жить дружно 🙂
```

В уведомлении доступны шаблоны `{user}`, `{username}`, `{userId}`, `{token}`, `{reason}` и `{action}`. Для обычной работы лучше не показывать `{token}` в чате, чтобы не повторять удалённую лексику.

## Production через Webhook

Webhook должен быть публично доступен по HTTPS на порту 443. Локально приложение слушает `WEBHOOK_PORT`; обычно перед ним ставят nginx, Caddy, Traefik или другой reverse proxy с HTTPS.

1. Заполните в `.env`:

```dotenv
WEBHOOK_PUBLIC_URL=https://your-domain.ru/max/webhook
WEBHOOK_SECRET=change_me_12345
WEBHOOK_PATH=/max/webhook
```

2. Запустите сервер:

```powershell
npm run start:webhook
```

3. В отдельном терминале подпишите бота на webhook:

```powershell
npm run webhook:subscribe
```

После активной webhook-подписки Long Polling не работает. Для локальной разработки используйте что-то одно.

## Настройка фильтра

Встроенный фильтр ловит основные русские корни мата и простую маскировку внутри слова: точки, цифры и похожие латинские буквы.

Посмотреть встроенный словарь можно локально:

```powershell
npm run dictionary:show
```

Дополнительные слова можно добавить без изменения кода:

```dotenv
CUSTOM_BAD_WORDS=оскорбление1,оскорбление2
```

Исключения добавляются так:

```dotenv
ALLOW_WORDS=слово1,слово2
```

## Команды словаря в боте

Чтобы менять словарь через MAX, сначала напишите боту:

```text
/id
```

Бот вернёт ваш `user_id`. Добавьте его в `.env`:

```dotenv
BOT_ADMIN_IDS=123456789
CUSTOM_DICTIONARY_PATH=data/custom-dictionary.json
```

После изменения `.env` перезапустите бота. Команды администратора:

```text
/badwords
/banword слово
/unbanword слово
/allowword слово
/unallowword слово
```

Команда `/badwords` показывает размер встроенного словаря и пользовательские добавления. Полный встроенный словарь в чат не выводится, чтобы не засорять переписку.

Если фильтр слишком строгий или мягкий, правьте правила в `src/profanity.js` и запускайте:

```powershell
npm test
```
