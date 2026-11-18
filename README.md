# RDX Squad — Research Department Explosive

Сайт сквада, бот **@RDX_Squad_OfficialBot** (заявки, обжалование бана, связь с командирами, RDX_AI) и бот **@RDX_AI_OfficialBot** (ИИ-помощник).

- `index.html` — сайт (один файл, без сборки). Настройки — объект `CFG` в конце файла.
- `assets/` — эмблема (`rdx-emblem.svg`) и аватарки ботов (`avatar-rdx.png`, `avatar-rdx-ai.png`).
- `img/gallery/` — скриншоты для галереи.
- `supabase/functions/rdx-api/` — сервер сайта и обоих ботов (Supabase Edge Function).
- `supabase/rdx_tables.sql` — таблицы.

Токены ботов хранятся только в секретах Supabase-функции, в репозитории их нет.

Команды командира в боте RDX: `/apps`, `/admin`, `/tokens @ник`, `/reset @ник`, `/add @ник 10 [дней]`, `/unlim @ник [дней|off]`, `/grant @ник vip|premium|plus|ultra|max [дней|навсегда]`, `/grant @ник none`.
