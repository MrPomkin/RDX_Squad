# RDX Squad — Revolvers and Explosives

Сайт сквада, бот **@RDX_Squad_OfficialBot** (заявки, обжалование бана, связь с командирами, RDX_AI) и бот **@RDX_AI_OfficialBot** (ИИ-помощник).

- `index.html` — сайт (один файл, без сборки). Настройки — объект `CFG` в конце файла.
- `assets/` — эмблема (`rdx-emblem.svg`) и аватарки ботов (`avatar-rdx.png`, `avatar-rdx-ai.png`).
- `img/gallery/` — скриншоты для галереи.
- `supabase/functions/rdx-api/` — сервер сайта и обоих ботов (Supabase Edge Function).
- `supabase/rdx_tables.sql` — таблицы.

Токены ботов хранятся только в секретах Supabase-функции, в репозитории их нет.
