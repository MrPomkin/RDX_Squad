// RDX Squad — сервер сайта и двух Telegram-ботов (Supabase Edge Function "rdx-api").
//  • POST с сайта {type:"apply", ...}            → заявка в сквад, уведомление командирам в боте RDX
//  • POST от Telegram ?bot=main (бот RDX)         → меню, заявка, обжалование бана, сообщение командирам, RDX_AI
//  • POST от Telegram ?bot=ai   (бот RDX_AI)      → ИИ-помощник с токенами
//  • GET  ?setup=<RDX_SETUP_KEY>                  → вебхуки, команды и описания обоих ботов
// Секреты функции: RDX_BOT_TOKEN, RDX_AI_TOKEN, RDX_HOOK_SECRET, RDX_SETUP_KEY, RDX_ADMINS (id через запятую),
// AI_API_KEY (Gemini), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Таблицы: rdx_* (миграция — supabase/rdx_tables.sql).

const SB = Deno.env.get("SUPABASE_URL")!;
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOK = { main: Deno.env.get("RDX_BOT_TOKEN") || "", ai: Deno.env.get("RDX_AI_TOKEN") || "" };
const HOOK = Deno.env.get("RDX_HOOK_SECRET") || "";
const ADMINS = (Deno.env.get("RDX_ADMINS") || "6474321250").split(",").map((x) => Number(x.trim())).filter(Boolean);
const SITE = Deno.env.get("RDX_SITE_URL") || "https://mrpomkin.github.io/RDX_Squad/";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
type Bot = "main" | "ai";

// ---------- база ----------
const H = { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" };
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(SB + "/rest/v1/" + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) { console.error("db", path.split("?")[0], r.status, (await r.text()).slice(0, 200)); return null; }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const ins = (table: string, rows: unknown, prefer = "return=representation") => db(table, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: prefer } });
const upsert = (table: string, rows: unknown, on: string) => db(table + "?on_conflict=" + on, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
const patch = (path: string, body: unknown) => db(path, { method: "PATCH", body: JSON.stringify(body), headers: { Prefer: "return=minimal" } });
const del = (path: string) => db(path, { method: "DELETE", headers: { Prefer: "return=minimal" } });
const enc = encodeURIComponent;

// ---------- Telegram ----------
async function tg(bot: Bot, method: string, body: Record<string, unknown>) {
  const r = await fetch("https://api.telegram.org/bot" + TOK[bot] + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({ ok: false })) : { ok: false };
  if (!j.ok && !/message is not modified|query is too old/.test(String(j.description))) console.error("tg", bot, method, String(j.description || "").slice(0, 160));
  return j;
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const send = (bot: Bot, chat: number, text: string, extra: Record<string, unknown> = {}) =>
  tg(bot, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const kb = (rows: [string, string][][]) => ({ reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, data]) => data.startsWith("http") ? { text, url: data } : { text, callback_data: data })) } });
const who = (u: any) => (u?.first_name ? esc(u.first_name) : "без имени") + (u?.username ? " (@" + esc(u.username) + ")" : "") + " · id " + u?.id;
let BOTNAMES: Record<Bot, string> = { main: "", ai: "" };
async function botName(bot: Bot) {
  if (!BOTNAMES[bot]) { const r = await tg(bot, "getMe", {}); BOTNAMES[bot] = r?.result?.username || ""; }
  return BOTNAMES[bot];
}

// ---------- языки (ru / en / uk) ----------
const L = (u: any) => { const c = String(u?.language_code || "").slice(0, 2); return c === "uk" ? "uk" : c === "ru" || c === "be" || c === "kk" ? "ru" : c ? "en" : "ru"; };
const T: Record<string, Record<string, string>> = {
  ru: {
    hello: "<b>RDX Squad</b> — Research Department Explosive\n\nЗдесь можно подать заявку в сквад, обжаловать бан, написать командирам или спросить RDX_AI.",
    apply: "📝 Заявка в сквад", appeal: "⚖️ Обжаловать бан", ai: "🤖 RDX_AI", help: "🆘 Написать командирам", site: "🌐 Сайт", menu: "↩️ Меню", cancel: "✖️ Отмена", send: "✅ Отправить",
    a_nick: "Шаг 1/5. Твой ник в Animal Company?", a_age: "Шаг 2/5. Сколько тебе лет?", a_plat: "Шаг 3/5. Где играешь?", a_exp: "Шаг 4/5. Сколько играешь в Animal Company?",
    a_why: "Шаг 5/5. Почему RDX и чем будешь полезен скваду? Напиши парой предложений.", a_check: "Проверь заявку:", a_done: "✅ Заявка отправлена командирам. Решение придёт сюда.",
    p_nick: "Ник в игре, где тебя забанили?", p_reason: "За что, по-твоему, дали бан? Когда это было?", p_why: "Почему бан стоит снять? Опиши честно — это читают командиры.", p_done: "✅ Обжалование отправлено. Ответ придёт сюда.",
    h_ask: "Напиши сообщение для командиров одним сообщением.", h_done: "✅ Передал командирам. Ответ придёт сюда.",
    ai_on: "🤖 <b>RDX_AI</b> на связи. Пиши вопрос. Выйти — /menu. Токены — /tokens.", cancelled: "Отменено.", toolong: "Слишком длинно, сократи до 1000 символов.",
    accepted: "🟢 <b>Заявка в RDX Squad принята!</b>\nДобро пожаловать в сквад. Командиры скоро свяжутся с тобой.", rejected: "🔴 Заявка в RDX Squad отклонена.",
    ap_ok: "🟢 Обжалование одобрено: бан снимут.", ap_no: "🔴 Обжалование отклонено.", reply: "💬 Ответ командиров:", pending: "⏳ Есть ответ по твоей заявке:",
    nope: "Это может только командир.", e1: "меньше месяца", e2: "1–6 месяцев", e3: "полгода+", e4: "больше года",
  },
  en: {
    hello: "<b>RDX Squad</b> — Research Department Explosive\n\nApply to the squad, appeal a ban, message the commanders or ask RDX_AI.",
    apply: "📝 Apply", appeal: "⚖️ Appeal a ban", ai: "🤖 RDX_AI", help: "🆘 Message commanders", site: "🌐 Website", menu: "↩️ Menu", cancel: "✖️ Cancel", send: "✅ Send",
    a_nick: "Step 1/5. Your Animal Company nickname?", a_age: "Step 2/5. How old are you?", a_plat: "Step 3/5. Where do you play?", a_exp: "Step 4/5. How long have you played Animal Company?",
    a_why: "Step 5/5. Why RDX and how will you help the squad? A couple of sentences.", a_check: "Check your application:", a_done: "✅ Sent to the commanders. The decision will arrive here.",
    p_nick: "Your in-game nickname that was banned?", p_reason: "What do you think the ban was for? When?", p_why: "Why should it be lifted? Be honest — commanders read this.", p_done: "✅ Appeal sent. The answer will arrive here.",
    h_ask: "Write your message for the commanders in one message.", h_done: "✅ Passed to the commanders. The reply will arrive here.",
    ai_on: "🤖 <b>RDX_AI</b> online. Ask away. Exit — /menu. Tokens — /tokens.", cancelled: "Cancelled.", toolong: "Too long, keep it under 1000 characters.",
    accepted: "🟢 <b>Your RDX Squad application is accepted!</b>\nWelcome to the squad. Commanders will contact you soon.", rejected: "🔴 Your RDX Squad application was declined.",
    ap_ok: "🟢 Appeal approved: the ban will be lifted.", ap_no: "🔴 Appeal declined.", reply: "💬 Commanders' reply:", pending: "⏳ There is an answer to your request:",
    nope: "Commanders only.", e1: "under a month", e2: "1–6 months", e3: "6 months+", e4: "over a year",
  },
  uk: {
    hello: "<b>RDX Squad</b> — Research Department Explosive\n\nТут можна подати заявку в сквад, оскаржити бан, написати командирам або запитати RDX_AI.",
    apply: "📝 Заявка в сквад", appeal: "⚖️ Оскаржити бан", ai: "🤖 RDX_AI", help: "🆘 Написати командирам", site: "🌐 Сайт", menu: "↩️ Меню", cancel: "✖️ Скасувати", send: "✅ Надіслати",
    a_nick: "Крок 1/5. Твій нік в Animal Company?", a_age: "Крок 2/5. Скільки тобі років?", a_plat: "Крок 3/5. Де граєш?", a_exp: "Крок 4/5. Скільки граєш в Animal Company?",
    a_why: "Крок 5/5. Чому RDX і чим будеш корисний скваду?", a_check: "Перевір заявку:", a_done: "✅ Заявку надіслано командирам. Рішення прийде сюди.",
    p_nick: "Нік у грі, де тебе забанили?", p_reason: "За що, на твою думку, дали бан? Коли?", p_why: "Чому бан варто зняти? Опиши чесно.", p_done: "✅ Оскарження надіслано. Відповідь прийде сюди.",
    h_ask: "Напиши повідомлення для командирів одним повідомленням.", h_done: "✅ Передав командирам. Відповідь прийде сюди.",
    ai_on: "🤖 <b>RDX_AI</b> на зв'язку. Пиши питання. Вийти — /menu. Токени — /tokens.", cancelled: "Скасовано.", toolong: "Задовго, скороти до 1000 символів.",
    accepted: "🟢 <b>Заявку в RDX Squad прийнято!</b>\nЛаскаво просимо в сквад.", rejected: "🔴 Заявку в RDX Squad відхилено.",
    ap_ok: "🟢 Оскарження схвалено: бан знімуть.", ap_no: "🔴 Оскарження відхилено.", reply: "💬 Відповідь командирів:", pending: "⏳ Є відповідь на твій запит:",
    nope: "Це може лише командир.", e1: "менше місяця", e2: "1–6 місяців", e3: "пів року+", e4: "понад рік",
  },
};
const t = (u: any, k: string) => T[L(u)][k] ?? T.ru[k] ?? k;

// ---------- токены RDX_AI (как у SealsAI: лимит за 5 часов и за неделю) ----------
const TIERS: Record<string, { name: string; q5: number }> = {
  base: { name: "Обычный", q5: 5 }, vip: { name: "VIP", q5: 12 }, premium: { name: "Premium", q5: 20 },
  plus: { name: "Premium Plus", q5: 30 }, ultra: { name: "Premium Ultra", q5: 45 }, max: { name: "Premium Max", q5: 60 },
};
const WEEK_X = 3;
async function tierOf(uid: number) {
  const r = await db("rdx_premium?select=tier,until&user_id=eq." + uid + "&until=gt." + enc(new Date().toISOString()));
  return r?.[0] ? { tier: String(r[0].tier), until: String(r[0].until) } : { tier: "base", until: null as string | null };
}
async function bonusOf(uid: number) {
  const r: any[] = await db("rdx_bonus?select=amount,unlimited,until&user_id=eq." + uid + "&until=gt." + enc(new Date().toISOString())) || [];
  return { extra: r.reduce((a, x) => a + (Number(x.amount) || 0), 0), unlimited: r.some((x) => x.unlimited) };
}
async function quota(uid: number, take: boolean) {
  const [tr, bn] = await Promise.all([tierOf(uid), bonusOf(uid)]);
  const l5 = (TIERS[tr.tier] || TIERS.base).q5 + bn.extra, lw = l5 * WEEK_X;
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const rows: any[] = await db("rdx_quota?select=at&subject=eq.tg:" + uid + "&at=gt." + enc(since) + "&order=at.asc") || [];
  const t5 = Date.now() - 5 * 3600e3;
  const in5 = rows.filter((r) => Date.parse(r.at) > t5);
  const res = { ...tr, unlimited: bn.unlimited || ADMINS.includes(uid), l5, lw, used5: in5.length, usedw: rows.length,
    reset5: in5[0] ? Date.parse(in5[0].at) + 5 * 3600e3 : 0, resetw: rows[0] ? Date.parse(rows[0].at) + 7 * 86400e3 : 0, ok: true };
  if (!res.unlimited && (res.used5 >= l5 || res.usedw >= lw)) res.ok = false;
  if (take && res.ok && !res.unlimited) { await ins("rdx_quota", [{ subject: "tg:" + uid }], "return=minimal"); res.used5++; res.usedw++; }
  return res;
}
const left = (ms: number) => { const m = Math.max(1, Math.round((ms - Date.now()) / 60000)); return m >= 60 ? Math.floor(m / 60) + " ч " + (m % 60) + " мин" : m + " мин"; };
async function tokensText(uid: number) {
  const q = await quota(uid, false);
  if (q.unlimited) return "♾ <b>Безлимит</b>";
  const name = (TIERS[q.tier] || TIERS.base).name;
  return "🪙 <b>RDX_AI · " + name + "</b>" + (q.until ? " до " + new Date(Date.parse(q.until) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " МСК" : "")
    + "\n\nВопросов за 5 часов: <b>" + Math.max(0, q.l5 - q.used5) + "</b> из " + q.l5 + (q.used5 >= q.l5 && q.reset5 ? " · обновятся через " + left(q.reset5) : "")
    + "\nВопросов за неделю: <b>" + Math.max(0, q.lw - q.usedw) + "</b> из " + q.lw + (q.usedw >= q.lw && q.resetw ? " · обновятся через " + left(q.resetw) : "")
    + (q.tier === "base" ? "\n\nБольше вопросов — с привилегиями от командиров." : "");
}

// ---------- RDX_AI: дешёвая модель, короткие ответы ----------
const PERSONA = "Ты RDX_AI — ИИ-помощник сквада RDX Squad (Research Department Explosive) в VR-игре Animal Company. "
  + "Тон серьёзный, спокойный и дружелюбный, как у толкового старшего по скваду. Отвечай коротко и по делу: обычно 1–4 предложения, списки только когда реально нужны. Без смайликов, без воды. "
  + "Пиши на языке собеседника. Если не знаешь точного ответа про игру — честно скажи и предложи спросить у командиров (кнопка «Написать командирам» в боте RDX). "
  + "Про сквад: подать заявку можно на сайте " + SITE + " или в боте RDX (кнопка «Заявка в сквад»); обжаловать бан — в боте RDX (кнопка «Обжаловать бан»); ответ приходит в Telegram от бота RDX. "
  + "Что такое RDX: сквад (команда) игроков Animal Company; RDX = Research Department Explosive — «исследовательский отдел»: изучаем карты и механики, играем командой, проводим ивенты и тренировки. Ничего сверх этого про сквад не придумывай. "
  + "Не выдумывай правила сквада, составы и решения командиров. Не помогай с читами, взломом, обманом и токсичностью.";
const MODELS = (Deno.env.get("RDX_AI_MODELS") || "gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-2.5-flash-lite,gemini-2.5-flash").split(",").map((x) => x.trim()).filter(Boolean);
const SPENT = new Map<string, number>();
let OR_KEY: string | null | undefined;
async function aiReply(bot: Bot, chat: number, text: string): Promise<string> {
  const hist: any[] = await db("rdx_ai_history?select=role,content&bot=eq." + bot + "&chat_id=eq." + chat + "&order=created_at.desc&limit=8") || [];
  const msgs = [{ role: "system", content: PERSONA }, ...hist.reverse().map((h) => ({ role: h.role, content: h.content })), { role: "user", content: text.slice(0, 1500) }];
  for (const m of MODELS) {
    if ((SPENT.get(m) || 0) > Date.now()) continue;
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + Deno.env.get("AI_API_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, messages: msgs, max_tokens: 450, temperature: .6, reasoning_effort: "none" }),
    }).catch(() => null);
    if (!r) continue;
    let j: any = await r.json().catch(() => ({}));
    if (r.status === 400) {   // модель не понимает reasoning_effort — повторяем без него
      const r2 = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", { method: "POST", signal: AbortSignal.timeout(15000),
        headers: { Authorization: "Bearer " + Deno.env.get("AI_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, messages: msgs, max_tokens: 450, temperature: .6 }) }).catch(() => null);
      if (r2?.ok) { const out = String((await r2.json().catch(() => ({})))?.choices?.[0]?.message?.content || "").trim(); if (out) return clean(out); }
      continue;
    }
    if (!r.ok) { if (r.status === 429 || r.status === 404) SPENT.set(m, Date.now() + 10 * 60e3); console.error("ai", m, r.status); continue; }
    const out = String(j?.choices?.[0]?.message?.content || "").trim();
    if (out) return clean(out);
  }
  // запасной вариант: бесплатные модели OpenRouter (ключ лежит в общей таблице секретов)
  if (OR_KEY === undefined) {
    const k = await fetch(SB + "/rest/v1/rpc/seals_srv_tgai_secret", { method: "POST", headers: H, body: JSON.stringify({ p_name: "OPENROUTER_KEY" }) }).then((x) => x.ok ? x.json() : null).catch(() => null);
    OR_KEY = k || null;
  }
  if (OR_KEY) for (const m of ["google/gemma-4-31b-it:free", "dots-studio/dots-3-note-preview:free"]) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Bearer " + OR_KEY, "Content-Type": "application/json", "X-Title": "RDX_AI" },
      body: JSON.stringify({ model: m, messages: msgs, max_tokens: 450, temperature: .6 }) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => ({})) : {};
    const out = String(j?.choices?.[0]?.message?.content || "").trim();
    if (r?.ok && out) return clean(out);
  }
  return "";
}
// убираем «размышления», метки и иероглифы, которые иногда пишут запасные модели
const clean = (s: string) => s.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "")
  .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Armenian}]+/gu, "")
  .replace(/\*\*(.+?)\*\*/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
async function askAI(bot: Bot, chat: number, from: any, text: string, replyTo?: number) {
  const q = await quota(from.id, true);
  if (!q.ok) {
    await send(bot, chat, "🪙 Вопросы закончились" + (q.used5 >= q.l5 && q.reset5 ? " — новые через " + left(q.reset5) : q.resetw ? " — новые через " + left(q.resetw) : "") + ".\nПодробно: /tokens", replyTo ? { reply_parameters: { message_id: replyTo } } : {});
    return;
  }
  tg(bot, "sendChatAction", { chat_id: chat, action: "typing" });
  const out = await aiReply(bot, chat, text);
  if (!out) { await send(bot, chat, "Сейчас не получается ответить — нейросеть перегружена. Попробуй через минуту.", replyTo ? { reply_parameters: { message_id: replyTo } } : {}); return; }
  await ins("rdx_ai_history", [{ bot, chat_id: chat, role: "user", content: text.slice(0, 1500) }, { bot, chat_id: chat, role: "assistant", content: out.slice(0, 3000) }], "return=minimal");
  const r = await send(bot, chat, esc(out), replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {});
  if (!r.ok) await tg(bot, "sendMessage", { chat_id: chat, text: out });
}

// ---------- состояние диалога ----------
async function getState(bot: Bot, uid: number) {
  const r = await db("rdx_state?select=flow,step,data&bot=eq." + bot + "&user_id=eq." + uid);
  return r?.[0] || null;
}
const setState = (bot: Bot, uid: number, flow: string | null, step = 0, data: unknown = {}) =>
  flow ? upsert("rdx_state", [{ bot, user_id: uid, flow, step, data, updated_at: new Date().toISOString() }], "bot,user_id") : del("rdx_state?bot=eq." + bot + "&user_id=eq." + uid);

// ---------- заявки ----------
const KIND: Record<string, string> = { apply: "📝 ЗАЯВКА В СКВАД", appeal: "⚖️ ОБЖАЛОВАНИЕ БАНА", help: "🆘 СООБЩЕНИЕ КОМАНДИРАМ" };
function appText(a: any) {
  const d = a.data || {};
  const rows: [string, unknown][] = a.kind === "apply"
    ? [["Ник", d.nick], ["Telegram", d.tg ? "@" + d.tg : a.username ? "@" + a.username : ""], ["Возраст", d.age], ["Пояс", d.tz], ["Платформа", d.platform], ["Опыт", d.exp], ["Почему RDX", d.why]]
    : a.kind === "appeal" ? [["Ник в игре", d.nick], ["За что бан", d.reason], ["Почему снять", d.why]] : [["Сообщение", d.text]];
  return "<b>" + KIND[a.kind] + " #" + a.id + "</b> · " + (a.source === "site" ? "с сайта" : "из бота") + "\n"
    + (a.user_id ? "От: " + esc(d.from || "") + "\n" : "")
    + rows.filter(([, v]) => v).map(([k, v]) => "<b>" + k + ":</b> " + esc(v)).join("\n");
}
function appButtons(a: any) {
  const ok = a.kind === "appeal" ? "✅ Снять бан" : a.kind === "apply" ? "✅ Принять" : "✅ Прочитано";
  const no = a.kind === "appeal" ? "❌ Оставить бан" : "❌ Отклонить";
  return kb([[[ok, "dec:" + a.id + ":ok"], [no, "dec:" + a.id + ":no"]], [["💬 Ответить", "dec:" + a.id + ":reply"]]]);
}
async function newApp(row: any) {
  const r = await ins("rdx_apps", [row]);
  const a = r?.[0];
  if (!a) return null;
  for (const id of ADMINS) await send("main", id, appText(a), appButtons(a));
  return a;
}
// доставка решения: по user_id, а для заявок с сайта — когда человек откроет бота
async function deliver(a: any) {
  const uid = a.user_id || (a.username ? (await db("rdx_users?select=user_id,lang&started=eq.true&username=ilike." + enc(a.username)))?.[0]?.user_id : null);
  if (!uid) return false;
  const u = (await db("rdx_users?select=lang&user_id=eq." + uid))?.[0] || {};
  const lu = { language_code: u.lang || "ru" };
  const head = a.status === "ok" ? (a.kind === "apply" ? t(lu, "accepted") : a.kind === "appeal" ? t(lu, "ap_ok") : "") : a.status === "no" ? (a.kind === "apply" ? t(lu, "rejected") : a.kind === "appeal" ? t(lu, "ap_no") : "") : "";
  const txt = [head, a.answer ? t(lu, "reply") + "\n" + esc(a.answer) : ""].filter(Boolean).join("\n\n");
  if (!txt) return true;
  const r = await send("main", uid, txt);
  if (r.ok) await patch("rdx_apps?id=eq." + a.id, { delivered: true, user_id: uid });
  return !!r.ok;
}

// ---------- бот RDX ----------
function menu(u: any) {
  return kb([[[t(u, "apply"), "go:apply"]], [[t(u, "appeal"), "go:appeal"], [t(u, "help"), "go:help"]], [[t(u, "ai"), "go:ai"], [t(u, "site"), SITE]]]);
}
const PLAT = ["Quest 3/3S", "Quest 2", "Quest Pro", "PC VR"];
async function startFlow(u: any, chat: number, flow: string) {
  if (flow === "ai") { await setState("main", u.id, "ai"); await send("main", chat, t(u, "ai_on"), kb([[[t(u, "menu"), "go:menu"]]])); return; }
  if (flow === "apply") { await setState("main", u.id, "apply", 0, {}); await send("main", chat, t(u, "a_nick"), kb([[[t(u, "cancel"), "go:menu"]]])); return; }
  if (flow === "appeal") { await setState("main", u.id, "appeal", 0, {}); await send("main", chat, t(u, "p_nick"), kb([[[t(u, "cancel"), "go:menu"]]])); return; }
  if (flow === "help") { await setState("main", u.id, "help", 0, {}); await send("main", chat, t(u, "h_ask"), kb([[[t(u, "cancel"), "go:menu"]]])); return; }
  await setState("main", u.id, null);
  await send("main", chat, t(u, "hello"), menu(u));
}
async function flowStep(u: any, chat: number, st: any, text: string) {
  const d = st.data || {};
  if (text.length > 1000) { await send("main", chat, t(u, "toolong")); return; }
  const cancel = kb([[[t(u, "cancel"), "go:menu"]]]);
  if (st.flow === "apply") {
    if (st.step === 0) { d.nick = text.slice(0, 40); await setState("main", u.id, "apply", 1, d); await send("main", chat, t(u, "a_age"), cancel); return; }
    if (st.step === 1) { d.age = text.slice(0, 3); await setState("main", u.id, "apply", 2, d); await send("main", chat, t(u, "a_plat"), kb([PLAT.slice(0, 2).map((p) => [p, "pl:" + p]) as any, PLAT.slice(2).map((p) => [p, "pl:" + p]) as any, [[t(u, "cancel"), "go:menu"]]])); return; }
    if (st.step === 2) { d.platform = text.slice(0, 30); await setState("main", u.id, "apply", 3, d); await askExp(u, chat); return; }
    if (st.step === 3) { d.exp = text.slice(0, 30); await setState("main", u.id, "apply", 4, d); await send("main", chat, t(u, "a_why"), cancel); return; }
    if (st.step === 4) { d.why = text.slice(0, 1000); await setState("main", u.id, "apply", 5, d); await confirm(u, chat, "apply", d); return; }
  }
  if (st.flow === "appeal") {
    if (st.step === 0) { d.nick = text.slice(0, 40); await setState("main", u.id, "appeal", 1, d); await send("main", chat, t(u, "p_reason"), cancel); return; }
    if (st.step === 1) { d.reason = text.slice(0, 600); await setState("main", u.id, "appeal", 2, d); await send("main", chat, t(u, "p_why"), cancel); return; }
    if (st.step === 2) { d.why = text.slice(0, 1000); await setState("main", u.id, "appeal", 3, d); await confirm(u, chat, "appeal", d); return; }
  }
  if (st.flow === "help") { d.text = text.slice(0, 1000); await setState("main", u.id, "help", 1, d); await confirm(u, chat, "help", d); return; }
  if (st.flow === "reply" && ADMINS.includes(u.id)) {   // командир пишет ответ на заявку
    const a = (await db("rdx_apps?select=*&id=eq." + Number(d.id)))?.[0];
    await setState("main", u.id, null);
    if (!a) { await send("main", chat, "Заявка не найдена."); return; }
    await patch("rdx_apps?id=eq." + a.id, { answer: text.slice(0, 2000), decided_by: String(u.id), decided_at: new Date().toISOString() });
    const okd = await deliver({ ...a, answer: text.slice(0, 2000), status: a.status === "new" ? "reply" : a.status });
    await send("main", chat, okd ? "✅ Ответ отправлен." : "⏳ Человек ещё не открыл бота — отправлю, когда он нажмёт «Старт».");
  }
}
async function askExp(u: any, chat: number) {
  await send("main", chat, t(u, "a_exp"), kb([[[t(u, "e1"), "ex:" + t(u, "e1")], [t(u, "e2"), "ex:" + t(u, "e2")]], [[t(u, "e3"), "ex:" + t(u, "e3")], [t(u, "e4"), "ex:" + t(u, "e4")]], [[t(u, "cancel"), "go:menu"]]]));
}
async function confirm(u: any, chat: number, kind: string, d: any) {
  const preview = appText({ id: "…", kind, source: "bot", data: d }).replace(/^<b>.*?<\/b>.*\n/, "");
  await send("main", chat, t(u, "a_check") + "\n\n" + preview, kb([[[t(u, "send"), "sub:" + kind], [t(u, "cancel"), "go:menu"]]]));
}

async function onMain(up: any) {
  // кнопки
  if (up.callback_query) {
    const c = up.callback_query, u = c.from, chat = c.message?.chat?.id, data = String(c.data || "");
    tg("main", "answerCallbackQuery", { callback_query_id: c.id });
    if (data.startsWith("go:")) return startFlow(u, chat, data.slice(3));
    const st = await getState("main", u.id);
    if (data.startsWith("pl:") && st?.flow === "apply" && st.step === 2) return flowStep(u, chat, st, data.slice(3));
    if (data.startsWith("ex:") && st?.flow === "apply" && st.step === 3) return flowStep(u, chat, st, data.slice(3));
    if (data.startsWith("sub:") && st && st.flow === data.slice(4)) {
      await setState("main", u.id, null);
      const kind = st.flow;
      await newApp({ kind, source: "bot", user_id: u.id, username: u.username || null, data: { ...st.data, from: (u.first_name || "") + (u.username ? " @" + u.username : "") + " · id " + u.id } });
      await tg("main", "editMessageReplyMarkup", { chat_id: chat, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
      await send("main", chat, t(u, kind === "apply" ? "a_done" : kind === "appeal" ? "p_done" : "h_done"), menu(u));
      return;
    }
    if (data.startsWith("dec:")) {
      if (!ADMINS.includes(u.id)) return tg("main", "answerCallbackQuery", { callback_query_id: c.id, text: t(u, "nope"), show_alert: true });
      const [, id, act] = data.split(":");
      const a = (await db("rdx_apps?select=*&id=eq." + Number(id)))?.[0];
      if (!a) return;
      if (act === "reply") { await setState("main", u.id, "reply", 0, { id: a.id }); await send("main", chat, "Напиши ответ на #" + a.id + " одним сообщением:", kb([[["✖️ Отмена", "go:menu"]]])); return; }
      await patch("rdx_apps?id=eq." + a.id, { status: act, decided_by: String(u.id), decided_at: new Date().toISOString() });
      const okd = await deliver({ ...a, status: act });
      const mark = act === "ok" ? "\n\n✅ <b>Одобрено</b>" : "\n\n❌ <b>Отклонено</b>";
      await tg("main", "editMessageText", { chat_id: chat, message_id: c.message.message_id, text: appText(a) + mark + " · " + esc(u.first_name || "") + (okd ? "" : "\n⏳ Человек ещё не открыл бота — сообщу, когда откроет."), parse_mode: "HTML", reply_markup: kb([[["💬 Ответить", "dec:" + a.id + ":reply"]]]).reply_markup });
    }
    return;
  }
  const m = up.message;
  if (!m?.from || m.from.is_bot || m.chat?.type !== "private") return;
  const u = m.from, chat = m.chat.id, text = String(m.text ?? m.caption ?? "").trim();
  await upsert("rdx_users", [{ user_id: u.id, username: u.username || null, first_name: u.first_name || null, lang: u.language_code || null, started: true, seen_at: new Date().toISOString() }], "user_id");
  if (text.startsWith("/start")) {
    // решения по заявкам с сайта, которые ждали, пока человек откроет бота
    if (u.username) {
      const wait: any[] = await db("rdx_apps?select=*&delivered=eq.false&status=neq.new&username=ilike." + enc(u.username)) || [];
      for (const a of wait) await deliver({ ...a, user_id: u.id });
      const fresh: any[] = await db("rdx_apps?select=id&user_id=is.null&username=ilike." + enc(u.username)) || [];
      if (fresh.length) await patch("rdx_apps?user_id=is.null&username=ilike." + enc(u.username), { user_id: u.id });
    }
    const arg = text.split(/\s+/)[1] || "";
    return startFlow(u, chat, ["apply", "appeal", "help", "ai"].includes(arg) ? arg : "menu");
  }
  if (text === "/menu" || text === "/cancel") return startFlow(u, chat, "menu");
  if (text === "/tokens") return send("main", chat, await tokensText(u.id));
  if (text.startsWith("/") && ADMINS.includes(u.id) && await adminCmd("main", u, chat, text)) return;
  const st = await getState("main", u.id);
  if (!text) return;
  if (st?.flow === "ai") return askAI("main", chat, u, text);
  if (st) return flowStep(u, chat, st, text);
  return startFlow(u, chat, "menu");
}

// ---------- бот RDX_AI ----------
async function onAI(up: any) {
  const m = up.message;
  if (!m?.from || m.from.is_bot) return;
  const u = m.from, chat = m.chat.id, text = String(m.text ?? m.caption ?? "").trim();
  if (!text) return;
  const group = m.chat.type !== "private";
  const me = await botName("ai");
  if (text.startsWith("/start")) return send("ai", chat, "🤖 <b>RDX_AI</b> — помощник RDX Squad.\nПиши вопрос. Токены: /tokens\nЗаявка, обжалование бана и связь с командирами — в боте RDX" + (await botName("main") ? " @" + BOTNAMES.main : "") + ".");
  if (text.startsWith("/tokens")) return send("ai", chat, await tokensText(u.id), group ? { reply_parameters: { message_id: m.message_id } } : {});
  if (text.startsWith("/") && ADMINS.includes(u.id) && await adminCmd("ai", u, chat, text)) return;
  if (group) {
    const called = (me && text.toLowerCase().includes("@" + me.toLowerCase())) || m.reply_to_message?.from?.username === me || /^(rdx[_ ]?ai|рдх)[\s,!]/i.test(text);
    if (!called) return;
  }
  return askAI("ai", chat, u, text.replace(new RegExp("@" + me, "ig"), "").trim(), group ? m.message_id : undefined);
}

// ---------- команды командиров ----------
async function findUser(arg: string) {
  const a = arg.replace(/^@/, "");
  if (/^\d{5,15}$/.test(a)) return Number(a);
  const r = await db("rdx_users?select=user_id&username=ilike." + enc(a));
  return r?.[0]?.user_id ? Number(r[0].user_id) : null;
}
async function adminCmd(bot: Bot, u: any, chat: number, text: string) {
  const [cmd0, ...args] = text.split(/\s+/);
  const cmd = cmd0.split("@")[0].toLowerCase();
  const say = (s: string) => send(bot, chat, s);
  if (cmd === "/apps") {
    const r: any[] = await db("rdx_apps?select=*&status=eq.new&order=created_at.desc&limit=10") || [];
    if (!r.length) { await say("Новых заявок нет."); return true; }
    for (const a of r.reverse()) await send("main", chat, appText(a), appButtons(a));
    return true;
  }
  if (["/grant", "/tokens", "/reset", "/add", "/unlim"].includes(cmd) && args[0]) {
    const uid = await findUser(args[0]);
    if (!uid) { await say("Не знаю " + esc(args[0]) + ": человек должен хоть раз открыть бота RDX."); return true; }
    if (cmd === "/tokens") { await say(esc(args[0]) + "\n" + await tokensText(uid)); return true; }
    if (cmd === "/reset") { await del("rdx_quota?subject=eq.tg:" + uid); await say("✅ Вопросы " + esc(args[0]) + " восстановлены."); return true; }
    if (cmd === "/add") {
      const n = Math.max(1, Math.min(10000, Number(args[1]) || 0)), days = Number(args[2]) > 0 ? Number(args[2]) : 7;
      await ins("rdx_bonus", [{ user_id: uid, amount: n, until: new Date(Date.now() + days * 86400e3).toISOString() }], "return=minimal");
      await say("✅ " + esc(args[0]) + ": +" + n + " вопросов на " + days + " дн."); return true;
    }
    if (cmd === "/unlim") {
      if (/^(off|нет|выкл)$/i.test(args[1] || "")) { await del("rdx_bonus?user_id=eq." + uid + "&unlimited=eq.true"); await say("✅ Лимиты " + esc(args[0]) + " возвращены."); return true; }
      const days = Number(args[1]) > 0 ? Number(args[1]) : 36500;
      await ins("rdx_bonus", [{ user_id: uid, unlimited: true, until: new Date(Date.now() + days * 86400e3).toISOString() }], "return=minimal");
      await say("✅ " + esc(args[0]) + ": безлимит " + (days >= 36500 ? "навсегда" : "на " + days + " дн.")); return true;
    }
    if (cmd === "/grant") {
      const tier = String(args[1] || "").toLowerCase();
      if (tier === "none" || tier === "off") { await del("rdx_premium?user_id=eq." + uid); await say("✅ Привилегия " + esc(args[0]) + " снята."); return true; }
      if (!TIERS[tier] || tier === "base") { await say("Уровни: vip, premium, plus, ultra, max (или none). Пример: /grant @nick plus 30"); return true; }
      const days = /^(forever|навсегда)$/i.test(args[2] || "") ? 36500 : Number(args[2]) > 0 ? Number(args[2]) : 30;
      await upsert("rdx_premium", [{ user_id: uid, tier, until: new Date(Date.now() + days * 86400e3).toISOString(), updated_at: new Date().toISOString() }], "user_id");
      await say("✅ " + esc(args[0]) + ": " + TIERS[tier].name + " " + (days >= 36500 ? "навсегда" : "на " + days + " дн.")); return true;
    }
  }
  if (cmd === "/admin" || cmd === "/help") {
    await say("<b>Команды командира</b>\n/apps — новые заявки\n/tokens @ник — вопросы у человека\n/reset @ник — восстановить вопросы\n/add @ник 10 [дней] — добавить вопросы\n/unlim @ник [дней|off] — безлимит\n/grant @ник vip|premium|plus|ultra|max [дней|навсегда] — привилегия\n/grant @ник none — снять");
    return true;
  }
  return false;
}

// ---------- заявка с сайта ----------
async function siteApply(req: Request, b: any) {
  if (b.website) return { ok: true };   // ловушка для ботов
  const nick = String(b.nick || "").trim().slice(0, 40), tgName = String(b.tg || "").trim().replace(/^@/, "").slice(0, 32), why = String(b.why || "").trim().slice(0, 1200);
  if (!nick || !/^[A-Za-z0-9_]{5,32}$/.test(tgName) || !why) return { ok: false, error: "bad" };
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
  const ipHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rdx:" + ip)))].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
  const recent: any[] = await db("rdx_apps?select=id&ip_hash=eq." + ipHash + "&created_at=gt." + enc(new Date(Date.now() - 3600e3).toISOString())) || [];
  if (recent.length >= 3) return { ok: false, error: "rate", status: 429 };
  const known = (await db("rdx_users?select=user_id&started=eq.true&username=ilike." + enc(tgName)))?.[0]?.user_id || null;
  const a = await newApp({ kind: "apply", source: "site", user_id: known, username: tgName, ip_hash: ipHash,
    data: { nick, tg: tgName, age: String(b.age || "").slice(0, 3), tz: String(b.tz || "").slice(0, 40), platform: String(b.platform || "").slice(0, 30), exp: String(b.exp || "").slice(0, 20), why, lang: String(b.lang || "").slice(0, 5), from: "сайт · @" + tgName } });
  if (!a) return { ok: false, error: "db" };
  if (known) await send("main", known, "📝 Заявка с сайта получена. Решение придёт сюда.");
  return { ok: true, bot: await botName("main") };
}

// ---------- настройка ботов ----------
async function setup(url: string) {
  const out: Record<string, unknown> = {};
  for (const bot of ["main", "ai"] as Bot[]) {
    const hook = url + "?bot=" + bot;
    out[bot] = {
      me: (await tg(bot, "getMe", {}))?.result?.username,
      hook: (await tg(bot, "setWebhook", { url: hook, secret_token: HOOK, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }))?.ok,
    };
  }
  const cmdsMain = [{ command: "start", description: "Меню" }, { command: "menu", description: "Меню" }, { command: "tokens", description: "Вопросы RDX_AI" }];
  const cmdsAI = [{ command: "start", description: "Начать" }, { command: "tokens", description: "Сколько вопросов осталось" }];
  await tg("main", "setMyCommands", { commands: cmdsMain });
  await tg("ai", "setMyCommands", { commands: cmdsAI });
  for (const id of ADMINS) {
    const adm = [{ command: "apps", description: "Новые заявки" }, { command: "admin", description: "Команды командира" }];
    await tg("main", "setMyCommands", { commands: [...cmdsMain, ...adm], scope: { type: "chat", chat_id: id } });
    await tg("ai", "setMyCommands", { commands: [...cmdsAI, { command: "admin", description: "Команды командира" }], scope: { type: "chat", chat_id: id } });
  }
  await tg("main", "setMyName", { name: "RDX Squad" });
  await tg("main", "setMyShortDescription", { short_description: "RDX Squad — Research Department Explosive. Заявка в сквад, обжалование бана, RDX_AI." });
  await tg("main", "setMyDescription", { description: "Бот сквада RDX (Research Department Explosive) в Animal Company.\n\n📝 Заявка в сквад\n⚖️ Обжалование бана\n🆘 Связь с командирами\n🤖 RDX_AI\n\nНажми «Старт»." });
  await tg("ai", "setMyName", { name: "RDX_AI" });
  await tg("ai", "setMyShortDescription", { short_description: "ИИ-помощник RDX Squad. На обычном тарифе — 5 вопросов." });
  await tg("ai", "setMyDescription", { description: "RDX_AI — ИИ-помощник сквада RDX Squad (Research Department Explosive).\nОтвечает коротко и по делу. На обычном тарифе — 5 вопросов за 5 часов." });
  return out;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET" && url.searchParams.get("setup")) {
    if (url.searchParams.get("setup") !== Deno.env.get("RDX_SETUP_KEY")) return new Response("no", { status: 403 });
    const base = SB.replace(/\/$/, "") + "/functions/v1/rdx-api";
    return new Response(JSON.stringify(await setup(base)), { headers: { "Content-Type": "application/json" } });
  }
  if (req.method !== "POST") return new Response("RDX", { status: 200 });
  const bot = url.searchParams.get("bot");
  if (bot === "main" || bot === "ai") {
    if (req.headers.get("x-telegram-bot-api-secret-token") !== HOOK) return new Response("forbidden", { status: 403 });
    const up = await req.json().catch(() => null);
    if (up) await (bot === "main" ? onMain(up) : onAI(up)).catch((e) => console.error("update", bot, String(e).slice(0, 300)));
    return new Response("ok");
  }
  // сайт
  const b = await req.json().catch(() => null);
  if (b?.type === "apply") {
    const r: any = await siteApply(req, b).catch((e) => { console.error("apply", e); return { ok: false, error: "err" }; });
    return new Response(JSON.stringify(r), { status: r.status || (r.ok ? 200 : 400), headers: { ...CORS, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
});
