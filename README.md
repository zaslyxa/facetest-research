# Facetest

Небольшое веб-приложение для исследования узнавания лиц. Сейчас вместо фотографий используются числа 1-20, чтобы можно было проверить процедуру без материалов. Позже числа заменяются на реальные фото. Участник открывает ссылку, заполняет анкету, видит стимулы в случайном порядке и отвечает `Y` или `N`. Если ответ `Y`, появляется открытый вопрос. По каждому стимулу сохраняются ID сессии, данные анкеты, ID стимула, ответ, текст открытого ответа, размер экрана и время реакции.

## Бесплатная схема

Рекомендуемый вариант:

1. **Хостинг сайта:** GitHub Pages. Для бесплатного GitHub Free используйте публичный репозиторий. Для этого проекта нужен только статический сайт.
2. **Хранение ответов:** Supabase Free. Приложение пишет строки в таблицу через публичный anon key, а чтение с сайта закрыто политиками RLS.
3. **Фото позже:** хранить прямо в проекте в `assets/photos/...`. Репозиторий лучше держать приватным, но сами фото будут доступны участникам по ссылке, потому что сайт должен их показывать.

Полезные официальные страницы:

- GitHub Pages: https://pages.github.com/
- Supabase pricing: https://supabase.com/pricing

## Структура

- `index.html` - интерфейс анкеты и эксперимента.
- `app.js` - рандомизация, таймер, измерение реакции, запись результатов.
- `config.js` - настройки Supabase и текста вопроса.
- `data/photo-sets.js` - главный список трех наборов стимулов; работает даже при открытии `index.html` без локального сервера.
- `data/photo-sets.json` - справочная JSON-копия текущих тестовых чисел.
- `assets/photos/` - папки для будущих фотографий.
- `supabase-schema.sql` - таблица и политика записи для Supabase.
- `supabase-report-query.sql` - запрос для отчета.

## Как добавить реальные фотографии

1. Положите файлы в одну из папок:
   - `assets/photos/set-a/`
   - `assets/photos/set-b/`
   - `assets/photos/set-c/`
2. Откройте `data/photo-sets.js`.
3. Замените числовые стимулы на записи изображений:

```js
{
  "id": "a-003",
  "type": "image",
  "src": "assets/photos/set-a/a-003.jpg"
}
```

`id` попадет в отчет как ID стимула. Его лучше делать стабильным и не менять после начала сбора данных.

## Как раздать разные ссылки группам

После публикации сайта отправляйте участникам разные ссылки:

- Группа 1: `https://YOUR_SITE/?set=set-a`
- Группа 2: `https://YOUR_SITE/?set=set-b`
- Группа 3: `https://YOUR_SITE/?set=set-c`

Если параметр `set` не указан, приложение покажет выбор группы в анкете. Это можно отключить в `config.js`, установив `allowSetChoiceWhenMissingUrl: false`.

## Настройка Supabase

1. Создайте проект в Supabase.
2. Откройте SQL Editor и выполните `supabase-schema.sql`.
3. В Supabase откройте Project Settings -> API.
4. Скопируйте Project URL и public anon key.
5. Вставьте их в `config.js`:

```js
window.EXPERIMENT_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY",
  supabaseTable: "experiment_responses",
  stimulusDurationMs: 3000,
  openQuestion: "Что именно вы запомнили о человеке?",
  requireDesktop: true,
  minimumViewportWidth: 760,
  minimumViewportHeight: 520,
  allowSetChoiceWhenMissingUrl: true,
  showDebugDownload: false
};
```

Публичный anon key можно размещать в браузерном приложении. Защита делается не секретностью ключа, а политиками RLS: в текущей схеме участники могут только добавлять строки, но не читать таблицу через сайт.

## Как получить отчет

В Supabase откройте SQL Editor и выполните `supabase-report-query.sql`. Результат можно экспортировать в CSV из интерфейса Supabase.

Колонки отчета:

- `session_id` и `participant_id`
- имя, возраст, пол
- размер экрана: `screen_width`, `screen_height`, `viewport_width`, `viewport_height`, `device_pixel_ratio`
- набор стимулов, порядок показа, ID стимула, тип стимула, значение стимула
- ответ `Y`, `N` или `NO_RESPONSE`
- открытый текстовый ответ
- `reaction_time_ms`
- время показа стимула

## Локальный запуск

Самый простой вариант: откройте файл `index.html` двойным кликом. Приложение не требует локального сервера. Также можно двойным кликом открыть `start-local.bat`.

Если хотите открыть через локальный адрес, можно запустить сервер:

Откройте терминал в папке проекта и запустите:

```powershell
python -m http.server 5173
```

Затем откройте:

```text
http://localhost:5173/?set=set-a&debug=1
```

`debug=1` показывает кнопку скачивания CSV после прохождения. Без настроенного Supabase это удобно для проверки логики.

Перед публикацией можно проверить манифест и пути к изображениям:

```powershell
node tools/check-project.js
```

## Деплой бесплатно через GitHub Pages

1. Загрузите проект в GitHub.
2. Откройте Settings -> Pages.
3. Выберите ветку и папку root.
4. Сохраните настройки.

Для GitHub Pages путь сайта может быть вида `https://USER.github.io/REPO/`. Ссылки групп тогда будут `https://USER.github.io/REPO/?set=set-a`.

Минимальные команды Git после создания пустого репозитория на GitHub:

```powershell
git init
git add .
git commit -m "Initial Facetest app"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

## Этика и персональные данные

Приложение собирает имя, возраст, пол и ответы участника. Перед реальным исследованием лучше добавить текст информированного согласия и убедиться, что у вас есть право использовать и показывать фотографии. Если имя не нужно для анализа, безопаснее заменить его на код участника.

## Что можно легко изменить

- Длительность показа: `stimulusDurationMs` в `config.js`.
- Текст открытого вопроса: `openQuestion` в `config.js`.
- Список групп и стимулов: `data/photo-sets.js`.
- Скачивание CSV на финальном экране: `showDebugDownload` в `config.js`.
