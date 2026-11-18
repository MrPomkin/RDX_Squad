-- Таблицы RDX Squad (бот RDX, бот RDX_AI, заявки с сайта). Доступ только у сервера (service role), RLS включён.
create table if not exists public.rdx_users (user_id bigint primary key, username text, first_name text, lang text, started boolean not null default false, created_at timestamptz not null default now(), seen_at timestamptz not null default now());
create index if not exists rdx_users_username on public.rdx_users (lower(username));
create table if not exists public.rdx_state (bot text not null, user_id bigint not null, flow text, step int not null default 0, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(), primary key (bot, user_id));
create table if not exists public.rdx_apps (id bigserial primary key, kind text not null, source text not null, user_id bigint, username text, data jsonb not null default '{}'::jsonb, status text not null default 'new', answer text, delivered boolean not null default false, ip_hash text, decided_by text, decided_at timestamptz, created_at timestamptz not null default now());
create index if not exists rdx_apps_status on public.rdx_apps (status, created_at desc);
create index if not exists rdx_apps_username on public.rdx_apps (lower(username));
create table if not exists public.rdx_ai_history (id bigserial primary key, bot text not null, chat_id bigint not null, role text not null, content text not null, created_at timestamptz not null default now());
create index if not exists rdx_ai_history_chat on public.rdx_ai_history (bot, chat_id, created_at desc);
create table if not exists public.rdx_quota (id bigserial primary key, subject text not null, at timestamptz not null default now());
create index if not exists rdx_quota_subject on public.rdx_quota (subject, at desc);
create table if not exists public.rdx_premium (user_id bigint primary key, tier text not null, until timestamptz not null, updated_at timestamptz not null default now());
create table if not exists public.rdx_bonus (id bigserial primary key, user_id bigint not null, amount int not null default 0, unlimited boolean not null default false, until timestamptz not null, created_at timestamptz not null default now());
do $$ declare t text; begin
  foreach t in array array['rdx_users','rdx_state','rdx_apps','rdx_ai_history','rdx_quota','rdx_premium','rdx_bonus'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
