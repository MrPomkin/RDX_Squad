// RDX Squad — сервер сайта и двух Telegram-ботов (Supabase Edge Function "rdx-api").
//  • POST с сайта {type:"apply", ...}            → заявка в сквад, уведомление командирам в боте RDX
//  • POST от Telegram ?bot=main (бот RDX)         → меню, заявка, обжалование бана, сообщение командирам, RDX_AI
//  • POST от Telegram ?bot=ai   (бот RDX_AI)      → ИИ-помощник с токенами
//  • GET  ?setup=<RDX_SETUP_KEY>                  → вебхуки, команды и описания обоих ботов
// Секреты функции: RDX_BOT_TOKEN, RDX_AI_TOKEN, RDX_HOOK_SECRET, RDX_SETUP_KEY, RDX_ADMINS (id создателя),
// RDX_MOD_KEY_HASH (SHA-256 ключа модератора: кто ввёл ключ в любом из ботов — модератор, принимает заявки),
// AI_API_KEY (Gemini), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Таблицы: rdx_* (миграция — supabase/rdx_tables.sql).

const SB = Deno.env.get("SUPABASE_URL")!;
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOK = { main: Deno.env.get("RDX_BOT_TOKEN") || "", ai: Deno.env.get("RDX_AI_TOKEN") || "" };
const HOOK = Deno.env.get("RDX_HOOK_SECRET") || "";
const ADMINS = (Deno.env.get("RDX_ADMINS") || "6474321250").split(",").map((x) => Number(x.trim())).filter(Boolean);
const OWNER_NICK = (Deno.env.get("RDX_OWNER_USERNAME") || "Mr_Wugi4").toLowerCase();
// создатель — по id или по нику; модераторы — те, кто ввёл ключ модератора
const isOwner = (u: any) => ADMINS.includes(Number(u?.id)) || String(u?.username || "").toLowerCase() === OWNER_NICK;
let MODS: { at: number; ids: number[] } | null = null;
async function modIds(): Promise<number[]> {
  if (!MODS || Date.now() - MODS.at > 30000) MODS = { at: Date.now(), ids: ((await db("rdx_mods?select=user_id")) || []).map((r: any) => Number(r.user_id)) };
  return MODS.ids;
}
const isMod = async (u: any) => isOwner(u) || (await modIds()).includes(Number(u?.id));
// кому слать заявки: создатель + модераторы
const staff = async () => [...new Set([...ADMINS, ...(await modIds())])];
const KEY_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
async function tryModKey(bot: Bot, m: any): Promise<boolean> {
  const raw = String(m.text || "").trim().toUpperCase();
  if (!KEY_RE.test(raw) || m.chat?.type !== "private") return false;
  const u = m.from, chat = m.chat.id;
  await tg(bot, "deleteMessage", { chat_id: chat, message_id: m.message_id });   // ключ не должен висеть в чате
  const since = new Date(Date.now() - 3600e3).toISOString();
  const tries: any[] = await db("rdx_quota?select=id&subject=eq.key:" + u.id + "&at=gt." + enc(since)) || [];
  if (tries.length >= 5) { await send(bot, chat, "Слишком много попыток. Подожди час."); return true; }
  await ins("rdx_quota", [{ subject: "key:" + u.id }], "return=minimal");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (hash !== Deno.env.get("RDX_MOD_KEY_HASH")) { await send(bot, chat, "Ключ не подошёл."); return true; }
  if (isOwner(u)) { await send(bot, chat, "👑 Ты создатель — у тебя и так все права."); return true; }
  await upsert("rdx_mods", [{ user_id: u.id, username: u.username || null, first_name: u.first_name || null, added_at: new Date().toISOString() }], "user_id");
  MODS = null;
  await modMenu(u.id, true);
  await send(bot, chat, "🛡 <b>Ключ принят — ты модератор RDX и SealsAI.</b> Сообщение с ключом я удалил.\nТвой уровень — «Модератор» (выше Premium Ultra). Твои команды: /mod\n\nЗаявки, обжалования и сообщения командирам будут приходить в бот RDX" + (BOTNAMES.main ? " @" + BOTNAMES.main : "") + " с кнопками — открой его и нажми «Старт».");
  for (const id of ADMINS) await send("main", id, "🛡 Новый модератор RDX: " + who(u));
  return true;
}
// меню команд для модератора (или вернуть обычное)
async function modMenu(uid: number, on: boolean) {
  const base = [{ command: "start", description: "Меню" }, { command: "menu", description: "Меню" }, { command: "tokens", description: "Вопросы RDX_AI" }];
  // команды для командиров не показываем никому, кроме создателя
  await tg("main", "deleteMyCommands", { scope: { type: "chat", chat_id: uid } });
  void base; void on;
}
const SITE = Deno.env.get("RDX_SITE_URL") || "https://mrpomkin.github.io/RDX_Squad/";
const SITE_APP = SITE + "?v=" + "20261119c";   // для кнопок «открыть сайт» в Telegram: новая метка = Telegram не покажет старую сохранённую копию
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
const kb = (rows: [string, string][][]) => ({ reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, data]) => data.startsWith("app:") ? { text, web_app: { url: data.slice(4) } } : data.startsWith("http") ? { text, url: data } : { text, callback_data: data })) } });
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
    hello: "<b>RDX Squad</b> — Revolvers and Explosives\n\nЗдесь можно подать заявку в сквад, обжаловать бан, написать командирам или спросить RDX_AI.",
    apply: "📝 Заявка в сквад", appeal: "⚖️ Обжаловать бан", ai: "🤖 RDX_AI", help: "🆘 Написать командирам", site: "🌐 Сайт", menu: "↩️ Меню", cancel: "✖️ Отмена", send: "✅ Отправить",
    a_nick: "Шаг 1/7. Твой ник в Animal Company?", a_age: "Шаг 2/7. Сколько тебе лет?", a_plat: "Шаг 3/7. Где играешь?", a_exp: "Шаг 4/7. Сколько играешь в Animal Company?",
    a_wpn: "Шаг 5/7. Любимое оружие? Выбери кнопкой или напиши своё.", a_why: "Шаг 7/7. Почему RDX и чем будешь полезен скваду? Напиши парой предложений.",
    a_dep: "Шаг 6/7. В какой отдел RDX хочешь вступить?\n\n💰 <b>Экономика</b> — фармеры и дюперы: добывают ресурсы и валюту и официально обеспечивают ими сквад.\n⚔️ <b>Штурм</b> — бойцы: рейды, захват позиций и защита своих.\n🔬 <b>Наука</b> — строители: возводят постройки, объекты и укрепления базы.",
    a_depreq: "Выбери отдел кнопкой ниже — свой вариант вписать нельзя.",
    leave: "🚪 Выйти из сквада", l_ask: "Почему хочешь выйти из RDX? Напиши коротко.", l_done: "✅ Запрос на выход отправлен командирам.", l_not: "Ты не в составе RDX — выходить неоткуда.",
    l_ok: "📄 <b>Мы рассмотрели ваше заявление об увольнении.</b>\nВы уволены из состава RDX Squad. Благодарим вас за службу и вклад в развитие сквада. Желаем удачи — двери RDX для вас остаются открытыми.", kicked: "👢 Ты был выгнан из клана RDX Squad.", bannedm: "⛔ Ты заблокирован в RDX Squad. Боты RDX, RDX_AI и SealsAI больше не будут тебе отвечать.", clan: "👥 Состав клана", l_no: "Командиры отклонили запрос на выход — поговори с ними.",
    talk_on: "🕵️ <b>Командир RDX хочет поговорить с тобой перед решением по заявке.</b>\nПросто отвечай сюда — сообщения передаются командиру.", talk_off: "Командир завершил разговор.", cmdr: "💬 <b>Командир RDX:</b>",
    member: "🎖 <b>Ты официально в составе RDX Squad.</b> Добро пожаловать!", a_check: "Проверь заявку:", a_done: "✅ Заявка отправлена командирам. Решение придёт сюда.",
    p_nick: "Ник в игре, где тебя забанили?", p_reason: "За что, по-твоему, дали бан? Когда это было?", p_why: "Почему бан стоит снять? Опиши честно — это читают командиры.", p_done: "✅ Обжалование отправлено. Ответ придёт сюда.",
    h_ask: "Напиши сообщение для командиров одним сообщением.", h_done: "✅ Передал командирам. Ответ придёт сюда.",
    ai_on: "🤖 <b>RDX_AI</b> на связи. Пиши вопрос. Выйти — /menu. Токены — /tokens.", cancelled: "Отменено.", toolong: "Слишком длинно, сократи до 1000 символов.",
    accepted: "🟢 <b>Заявка в RDX Squad принята!</b>\nДобро пожаловать в сквад. Командиры скоро свяжутся с тобой.", rejected: "🔴 Заявка в RDX Squad отклонена.",
    ap_ok: "🟢 Обжалование одобрено: бан снимут.", ap_no: "🔴 Обжалование отклонено.", reply: "💬 Ответ командиров:", pending: "⏳ Есть ответ по твоей заявке:",
    nope: "Это может только командир.", e1: "меньше месяца", e2: "1–6 месяцев", e3: "полгода+", e4: "больше года",
  },
  en: {
    hello: "<b>RDX Squad</b> — Revolvers and Explosives\n\nApply to the squad, appeal a ban, message the commanders or ask RDX_AI.",
    apply: "📝 Apply", appeal: "⚖️ Appeal a ban", ai: "🤖 RDX_AI", help: "🆘 Message commanders", site: "🌐 Website", menu: "↩️ Menu", cancel: "✖️ Cancel", send: "✅ Send",
    a_nick: "Step 1/7. Your Animal Company nickname?", a_age: "Step 2/7. How old are you?", a_plat: "Step 3/7. Where do you play?", a_exp: "Step 4/7. How long have you played Animal Company?",
    a_wpn: "Step 5/7. Favourite weapon? Pick a button or type your own.", a_why: "Step 7/7. Why RDX and how will you help the squad? A couple of sentences.",
    a_dep: "Step 6/7. Which RDX department do you want to join?\n\n💰 <b>Economy</b> — farmers and dupers: they gather resources and currency and officially supply the squad.\n⚔️ <b>Assault</b> — the fighters: raids, capturing positions and protecting our own.\n🔬 <b>Science</b> — the builders: they raise structures, objects and base defences.",
    a_depreq: "Pick a department with the buttons below — you can't type your own.",
    leave: "🚪 Leave the squad", l_ask: "Why do you want to leave RDX? Keep it short.", l_done: "✅ Leave request sent to the commanders.", l_not: "You're not in the RDX roster.",
    l_ok: "📄 <b>We have reviewed your resignation request.</b>\nYou are hereby discharged from RDX Squad. Thank you for your service and your contribution to the squad. Good luck — RDX's doors remain open to you.", kicked: "👢 You have been kicked from the RDX Squad clan.", bannedm: "⛔ You are banned from RDX Squad. The RDX, RDX_AI and SealsAI bots will no longer reply to you.", clan: "👥 Clan roster", l_no: "Commanders declined the leave request — talk to them.",
    talk_on: "🕵️ <b>An RDX commander wants to talk to you before deciding on your application.</b>\nJust reply here — messages go to the commander.", talk_off: "The commander ended the conversation.", cmdr: "💬 <b>RDX commander:</b>",
    member: "🎖 <b>You're officially in RDX Squad.</b> Welcome!", a_check: "Check your application:", a_done: "✅ Sent to the commanders. The decision will arrive here.",
    p_nick: "Your in-game nickname that was banned?", p_reason: "What do you think the ban was for? When?", p_why: "Why should it be lifted? Be honest — commanders read this.", p_done: "✅ Appeal sent. The answer will arrive here.",
    h_ask: "Write your message for the commanders in one message.", h_done: "✅ Passed to the commanders. The reply will arrive here.",
    ai_on: "🤖 <b>RDX_AI</b> online. Ask away. Exit — /menu. Tokens — /tokens.", cancelled: "Cancelled.", toolong: "Too long, keep it under 1000 characters.",
    accepted: "🟢 <b>Your RDX Squad application is accepted!</b>\nWelcome to the squad. Commanders will contact you soon.", rejected: "🔴 Your RDX Squad application was declined.",
    ap_ok: "🟢 Appeal approved: the ban will be lifted.", ap_no: "🔴 Appeal declined.", reply: "💬 Commanders' reply:", pending: "⏳ There is an answer to your request:",
    nope: "Commanders only.", e1: "under a month", e2: "1–6 months", e3: "6 months+", e4: "over a year",
  },
  uk: {
    hello: "<b>RDX Squad</b> — Revolvers and Explosives\n\nТут можна подати заявку в сквад, оскаржити бан, написати командирам або запитати RDX_AI.",
    apply: "📝 Заявка в сквад", appeal: "⚖️ Оскаржити бан", ai: "🤖 RDX_AI", help: "🆘 Написати командирам", site: "🌐 Сайт", menu: "↩️ Меню", cancel: "✖️ Скасувати", send: "✅ Надіслати",
    a_nick: "Крок 1/7. Твій нік в Animal Company?", a_age: "Крок 2/7. Скільки тобі років?", a_plat: "Крок 3/7. Де граєш?", a_exp: "Крок 4/7. Скільки граєш в Animal Company?",
    a_wpn: "Крок 5/7. Улюблена зброя? Обери кнопкою або напиши свою.", a_why: "Крок 7/7. Чому RDX і чим будеш корисний скваду?",
    a_dep: "Крок 6/7. До якого відділу RDX хочеш вступити?\n\n💰 <b>Економіка</b> — фармери й дюпери: добувають ресурси й валюту та офіційно забезпечують ними сквад.\n⚔️ <b>Штурм</b> — бійці: рейди, захоплення позицій і захист своїх.\n🔬 <b>Наука</b> — будівельники: зводять споруди, об'єкти й укріплення бази.",
    a_depreq: "Обери відділ кнопкою нижче — свій варіант вписати не можна.",
    leave: "🚪 Вийти зі скваду", l_ask: "Чому хочеш вийти з RDX? Коротко.", l_done: "✅ Запит на вихід надіслано командирам.", l_not: "Ти не у складі RDX.",
    l_ok: "📄 <b>Ми розглянули вашу заяву про звільнення.</b>\nВас звільнено зі складу RDX Squad. Дякуємо за службу та внесок у розвиток скваду. Бажаємо удачі — двері RDX для вас залишаються відкритими.", kicked: "👢 Тебе вигнали з клану RDX Squad.", bannedm: "⛔ Тебе заблоковано в RDX Squad. Боти RDX, RDX_AI і SealsAI більше не відповідатимуть тобі.", clan: "👥 Склад клану", l_no: "Командири відхилили запит на вихід — поговори з ними.",
    talk_on: "🕵️ <b>Командир RDX хоче поговорити з тобою перед рішенням щодо заявки.</b>\nПросто відповідай сюди.", talk_off: "Командир завершив розмову.", cmdr: "💬 <b>Командир RDX:</b>",
    member: "🎖 <b>Ти офіційно у складі RDX Squad.</b> Ласкаво просимо!", a_check: "Перевір заявку:", a_done: "✅ Заявку надіслано командирам. Рішення прийде сюди.",
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
  base: { name: "Обычный", q5: 5 }, vip: { name: "VIP", q5: 12 }, premium: { name: "Premium", q5: 20 }, clan: { name: "Боец RDX", q5: 24 },
  plus: { name: "Premium Plus", q5: 30 }, ultra: { name: "Premium Ultra", q5: 45 }, mod: { name: "Модератор", q5: 70 }, max: { name: "Premium Max", q5: 60 },
};
const RANK = ["base", "vip", "premium", "clan", "plus", "ultra", "mod", "max"];
const higher = (a: string, b: string) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);
const WEEK_X = 3;
// звания в клане (меняет только создатель). Лимиты: RDX_AI — вопросов за 5 ч; SealsAI — сообщений, картинок, Deep Search за 5 ч
const RANKS = ["Рядовой", "Ефрейтор", "Младший сержант", "Сержант", "Старшина", "Прапорщик", "Лейтенант", "Старший лейтенант", "Капитан", "Майор", "Полковник", "Генерал", "Маршал", "Модератор", "Админ"];
const RANK_Q5 = [24, 29, 33, 38, 43, 47, 52, 57, 61, 66, 71, 75, 80, 85, 90];
const RANK_SEALS = [[37, 12, 1], [41, 13, 2], [46, 14, 2], [51, 16, 2], [56, 17, 3], [60, 19, 3], [65, 20, 4], [70, 21, 4], [74, 23, 4], [79, 24, 5], [84, 26, 5], [89, 27, 6], [93, 28, 6], [100, 30, 6], [107, 32, 7]];
// 13 Модератор — права модератора; 14 Админ — права модератора + может менять звания бойцам до Маршала
const TOP_RANK = 14, MOD_RANK = 13, ADMIN_RANK = 14;
const MARSHAL = 13;   // промокоды Premium/Plus и раздача 1500 токенов — с 13-го звания (Модератор, Админ)
const MARSHAL_RANK = 12, MARSHAL_TOKENS = 1500, MARSHAL_PROMO_WEEK = 10, MARSHAL_PROMO_DAYS = 30;
RANKS.forEach((n, k) => { TIERS["r" + k] = { name: "Боец RDX · " + n + " (" + k + "/" + TOP_RANK + ")", q5: RANK_Q5[k] }; });
const rankName = (k: number) => RANKS[k] + " (" + k + "/" + TOP_RANK + ")";
async function rankOf(uid: number): Promise<number | null> {
  const r = (await db("rdx_members?select=rank&active=eq.true&user_id=eq." + uid))?.[0];
  return r ? Number(r.rank) || 0 : null;
}
// класс по званию и разделу: 0 стажёр · 1–4 новичок · 5–8 старший · 9–12 главный · 13–14 командир · создатель — полный класс
const DEPT_P: Record<string, [string, string]> = { "Наука": ["учёный", "учёных"], "Экономика": ["экономист", "экономистов"], "Штурм": ["штурмовик", "штурмовиков"] };
const DEPT_ICON: Record<string, string> = { "Наука": "🔬", "Экономика": "💰", "Штурм": "⚔️" };
function classOf(rank: number, dept: string | null, full = false) {
  if (full) return "Полный класс";
  const [one, many] = DEPT_P[dept || ""] || ["боец", "бойцов"];
  if (rank <= 0) return "Стажёр " + one;
  if (rank <= 4) return "Новичок " + one;
  if (rank <= 8) return "Старший " + one;
  if (rank <= 12) return "Главный " + one;
  return "Командир " + many;
}
// тип класса — по оружию, по той же лестнице: стажёр · новичок · старший · главный · командир (13–14 и создатель)
function typeNoun(weapon: string | null): [string, string] {
  const w = String(weapon || "").toLowerCase();
  if (/рпг|гранат|взрыв|подрыв|c4|с4|динамит|мин[аы]/.test(w)) return ["подрывник", "подрывников"];
  if (/револьв/.test(w)) return ["револьверщик", "револьверов"];
  if (/ближ|нож|бит|меч|кулак|топор|кастет/.test(w)) return ["боец ближнего боя", "бойцов ближнего боя"];
  if (/медик|аптеч|леч/.test(w)) return ["медик", "медиков"];
  return ["стрелок дальнего боя", "стрелков дальнего боя"];
}
function typeOf(rank: number, weapon: string | null, full = false) {
  if (!weapon) return "";
  const [one, many] = typeNoun(weapon);
  if (full || rank >= 13) return "Командир " + many;
  if (rank <= 0) return "Стажёр " + one;
  if (rank <= 4) return "Новичок " + one;
  if (rank <= 8) return "Старший " + one;
  return "Главный " + one;
}
// с 13-го звания (и у создателя): все разделы и все классы орудия, основной — в скобках
const deptText = (rank: number, dept: string | null, full = false) => (full || rank >= 13) ? "Все разделы" + (dept ? " (" + dept + ")" : "") : dept ? (DEPT_ICON[dept] || "") + " " + dept : "не выбран";
const weaponText = (rank: number, weapon: string | null, full = false) => (full || rank >= 13) ? "Все классы орудия" + (weapon ? " (" + weapon + ")" : "") : weapon || "";
// строки для /tokens: раздел, класс, класс орудия
async function classLines(uid: number) {
  const m = (await db("rdx_members?select=rank,dept,weapon&active=eq.true&user_id=eq." + uid))?.[0];
  if (!m) return "";
  const full = ADMINS.includes(uid);
  const rk = Number(m.rank) || 0, wt = weaponText(rk, m.weapon, full);
  return "\n🗂 Раздел: <b>" + deptText(rk, m.dept, full) + "</b>"
    + "\n🎓 Класс: <b>" + classOf(rk, m.dept, full) + (m.weapon ? ", " + m.weapon : "") + "</b>"
    + (m.weapon ? "\n🧩 Тип класса: <b>" + typeOf(rk, m.weapon, full) + "</b>" : "")
    + (wt ? "\n🔫 Класс орудия: <b>" + wt + "</b>" : "");
}
const isMarshal = async (u: any) => ((await rankOf(Number(u?.id))) ?? -1) >= MARSHAL;   // маршал и выше
const isRankAdmin = async (u: any) => (await rankOf(Number(u?.id))) === ADMIN_RANK;
function rankPerks(k: number) {
  return "• RDX_AI: " + RANK_Q5[k] + " вопросов за 5 часов\n• SealsAI: " + RANK_SEALS[k][0] + " сообщений, " + RANK_SEALS[k][1] + " картинок и " + RANK_SEALS[k][2] + " Deep Search за 5 часов"
    + (k >= MARSHAL ? "\n• Промокоды на Premium и Premium Plus — в RDX_AI и SealsAI (до " + MARSHAL_PROMO_WEEK + " в неделю, до " + MARSHAL_PROMO_DAYS + " дней)\n• Раздача до " + MARSHAL_TOKENS + " токенов в день в каждом боте" : "")
    + (k >= MOD_RANK ? "\n• Права модератора RDX и SealsAI: заявки с кнопками, допросы, бан, кик и увольнение из клана" : "")
    + (k === ADMIN_RANK ? "\n• Может повышать и понижать звания бойцов до Маршала" : "")
    + (k >= MARSHAL ? "\nВсе команды: /mod" : "");
}
async function tierOf(uid: number, withMod = true) {
  const r = await db("rdx_premium?select=tier,until&user_id=eq." + uid + "&until=gt." + enc(new Date().toISOString()));
  const own = r?.[0] ? { tier: String(r[0].tier), until: String(r[0].until) as string | null } : { tier: "base", until: null as string | null };
  if (!withMod) return own;
  // модератор и боец клана (по званию) получают свой уровень, если он сильнее собственного
  const pow = (t: string) => TIERS[t]?.q5 || 0;
  let best = own;
  if ((await modIds()).includes(uid) && pow("mod") > pow(best.tier)) best = { tier: "mod", until: null };
  const rk = await rankOf(uid);
  if (rk !== null && pow("r" + rk) > pow(best.tier)) best = { tier: "r" + rk, until: null };
  return best;
}
async function bonusOf(uid: number) {
  const r: any[] = await db("rdx_bonus?select=amount,unlimited,until&user_id=eq." + uid + "&until=gt." + enc(new Date().toISOString())) || [];
  return { extra: r.reduce((a, x) => a + (Number(x.amount) || 0), 0), unlimited: r.some((x) => x.unlimited) };
}
async function quota(uid: number, take: boolean) {
  const [tr, bn] = await Promise.all([tierOf(uid), bonusOf(uid)]);
  const l5 = (TIERS[tr.tier] || TIERS.base).q5, lw = l5 * WEEK_X;   // бонус — отдельный запас (bn.extra), тратится после лимита
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const rows: any[] = await db("rdx_quota?select=at&subject=eq.tg:" + uid + "&at=gt." + enc(since) + "&order=at.asc") || [];
  const t5 = Date.now() - 5 * 3600e3;
  const in5 = rows.filter((r) => Date.parse(r.at) > t5);
  const res = { ...tr, unlimited: bn.unlimited || ADMINS.includes(uid), l5, lw, used5: in5.length, usedw: rows.length,
    reset5: in5[0] ? Date.parse(in5[0].at) + 5 * 3600e3 : 0, resetw: rows[0] ? Date.parse(rows[0].at) + 7 * 86400e3 : 0, ok: true };
  const baseOk = res.unlimited || (res.used5 < l5 && res.usedw < lw);
  (res as any).bonus = bn.extra;
  if (!baseOk) res.ok = bn.extra > 0;
  if (take && res.ok && !res.unlimited) {
    if (!baseOk) {   // тратим бонус (из того, что раньше сгорает)
      const row = (await db("rdx_bonus?select=id,amount&user_id=eq." + uid + "&unlimited=eq.false&amount=gt.0&until=gt." + enc(new Date().toISOString()) + "&order=until.asc&limit=1"))?.[0];
      if (!row) { res.ok = false; return res; }
      await patch("rdx_bonus?id=eq." + row.id + "&amount=eq." + row.amount, { amount: row.amount - 1 });
      (res as any).bonus = bn.extra - 1;
    }
    await ins("rdx_quota", [{ subject: "tg:" + uid }], "return=minimal"); res.used5++; res.usedw++;
  }
  return res;
}
const left = (ms: number) => { const m = Math.max(1, Math.round((ms - Date.now()) / 60000)); return m >= 60 ? Math.floor(m / 60) + " ч " + (m % 60) + " мин" : m + " мин"; };
async function tokensText(uid: number) {
  const q = await quota(uid, false);
  const cls = await classLines(uid);
  if (q.unlimited) return "♾ <b>Безлимит</b>" + (ADMINS.includes(uid) ? "\n👑 Создатель RDX Squad" : "") + cls;
  const name = (TIERS[q.tier] || TIERS.base).name;
  const rk = await rankOf(uid);
  return (q.tier === "mod" ? "🛡 " : q.tier.startsWith("r") ? "💥 " : "🪙 ") + "<b>RDX_AI · " + name + "</b>"
    + (rk !== null && !q.tier.startsWith("r") ? "\n🎖 Звание в RDX: <b>" + rankName(rk) + "</b>" : "") + cls + (q.until ? " до " + new Date(Date.parse(q.until) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " МСК" : "")
    + "\n\nВопросов за 5 часов: <b>" + Math.max(0, q.l5 - q.used5) + "</b> из " + q.l5 + (q.used5 >= q.l5 && q.reset5 ? " · обновятся через " + left(q.reset5) : "")
    + "\nВопросов за неделю: <b>" + Math.max(0, q.lw - q.usedw) + "</b> из " + q.lw + (q.usedw >= q.lw && q.resetw ? " · обновятся через " + left(q.resetw) : "")
    + ((q as any).bonus > 0 ? "\n🎁 Бонусных вопросов: <b>" + (q as any).bonus + "</b> (тратятся, когда кончится лимит)" : "")
    + (q.tier === "base" ? "\n\nБольше вопросов — с привилегиями от командиров." : "");
}

// ---------- RDX_AI: дешёвая модель, короткие ответы ----------
const PERSONA = "Ты RDX_AI — ИИ-помощник сквада RDX Squad (Revolvers and Explosives) в VR-игре Animal Company. "
  + "Сквад RDX создали @Mr_Wugi4 (Матвей) и @Suxurik (Сухарик) — только они, больше никто; Матвей — главный создатель и твой создатель. Отделы: Экономика (фармеры и дюперы — добывают ресурсы и валюту и официально обеспечивают сквад), Штурм (боевое ядро: рейды, гриф, захват позиций, защита своих), Наука (инженеры: постройки, объекты и укрепления базы, поиск багов, секретов и новых механик). Бойцы клана получают уровень «Боец RDX» — чуть выше Premium — в RDX_AI и SealsAI. Создатель и модераторы могут попросить тебя обычными словами забанить, кикнуть или уволить бойца из клана или найти игрока — это выполняет сервер, сам ничего такого не обещай. "
  + "Тон серьёзный, спокойный и дружелюбный, как у толкового старшего по скваду. Отвечай коротко и по делу: обычно 1–4 предложения, списки только когда реально нужны. Без смайликов, без воды. "
  + "Пиши на языке собеседника. Если не знаешь точного ответа про игру — честно скажи и предложи спросить у командиров (кнопка «Написать командирам» в боте RDX). "
  + "Про сквад: подать заявку можно на сайте " + SITE + " или в боте RDX (кнопка «Заявка в сквад»); обжаловать бан — в боте RDX (кнопка «Обжаловать бан»); ответ приходит в Telegram от бота RDX. "
  + "Что такое RDX: сквад (команда) гриферов в Animal Company — грифим чужие базы, ведём рейды и захватываем позиции; RDX = Revolvers and Explosives (Revolvers anD eXplosives — «револьверы и взрывчатка»): изучаем карты и механики, играем командой, проводим ивенты и тренировки. В RDX три отдела: Экономика (фармеры и дюперы — добывают ресурсы и валюту и официально обеспечивают ими сквад), Штурм (бойцы: рейды, захват позиций, защита своих), Наука (строят постройки, объекты и укрепления базы). В заявке отдел обязательно выбирается из этих трёх. Ничего сверх этого про сквад не придумывай. "
  + "Не выдумывай правила сквада, составы и решения командиров. Не помогай с читами, взломом, обманом и токсичностью.";
const MODELS = (Deno.env.get("RDX_AI_MODELS") || "gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-2.5-flash-lite,gemini-2.5-flash").split(",").map((x) => x.trim()).filter(Boolean);
const SPENT = new Map<string, number>();
let OR_KEY: string | null | undefined;
async function aiReply(bot: Bot, chat: number, text: string): Promise<string> {
  const hist: any[] = await db("rdx_ai_history?select=role,content&bot=eq." + bot + "&chat_id=eq." + chat + "&order=created_at.desc&limit=8") || [];
  const roster = await clanAll().catch(() => [] as any[]);
  const rosterTxt = " Сейчас в строю клана RDX " + roster.length + " бойцов" + (roster.length && roster.length <= CLAN_BIG ? ": " + roster.map((x) => (x.nick || "Боец") + (x.username ? " (@" + x.username + ")" : "")).join(", ") : "") + ".";
  const msgs = [{ role: "system", content: PERSONA + rosterTxt }, ...hist.reverse().map((h) => ({ role: h.role, content: h.content })), { role: "user", content: text.slice(0, 1500) }];
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
// ---------- защита от утечки: служебные вызовы, куски инструкций и внутренний код в чат не уходят ----------
const LEAK_TOOLS = /\b(tokens_info|tokens_reset|tokens_add|tokens_unlimited|grant_premium|set_moderator|rdx_clan|generate_promos|delete_promos|set_role|role_status|remember_fact|web_search|generate_image|clear_chat|admin_logout|default_api)\b/i;
function leakKind(t: string, system: string): string | null {
  if (!t) return null;
  if (/(USE_TOOL|DONT_SEND|tool_call|function_call|tool_code|<\/?tool|<\/?function|"arguments"\s*:|"parameters"\s*:|\bprint\(\s*default_api)/i.test(t)) return "tool-syntax";
  if (LEAK_TOOLS.test(t)) return "tool-name";
  if (/(Deno\.env|SUPABASE_|SERVICE_ROLE|seals_srv_|SB_URL|BOT_BUNDLE|RDX_HOOK|RDX_SETUP|sk-or-|api\.telegram\.org\/bot|Authorization:\s*Bearer)/i.test(t)) return "code";
  if (/\[(СЕРВЕР|SYSTEM|SERVER)\]|систем(ный|ного) промпт|system prompt|мои инструкции гласят|my instructions/i.test(t)) return "meta";
  // кусок инструкции: два совпадения по 8 слов подряд с системным текстом + «инструкционные» слова
  if (system && /(инструмент|вызыва|никогда не|только когда|не путай|не выдумывай|сервер сам|пометк|не пересказывай|отказывай)/i.test(t)) {
    const norm = (x: string) => x.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9@]+/g, " ").split(" ").filter(Boolean);
    const sw = norm(system), grams = new Set<string>();
    for (let i = 0; i + 8 <= sw.length; i++) grams.add(sw.slice(i, i + 8).join(" "));
    const rw = norm(t); let hits = 0;
    for (let i = 0; i + 8 <= rw.length; i++) if (grams.has(rw.slice(i, i + 8).join(" ")) && ++hits >= 2) return "prompt";
  }
  return null;
}
async function askAI(bot: Bot, chat: number, from: any, text: string, replyTo?: number) {
  const ci = await clanIntent(from, text).catch((e) => { console.error("clan", e); return null; });
  if (ci) return send(bot, chat, ci, replyTo ? { reply_parameters: { message_id: replyTo } } : {});
  const q = await quota(from.id, true);
  if (!q.ok) {
    await send(bot, chat, "🪙 Вопросы закончились" + (q.used5 >= q.l5 && q.reset5 ? " — новые через " + left(q.reset5) : q.resetw ? " — новые через " + left(q.resetw) : "") + ".\nПодробно: /tokens", replyTo ? { reply_parameters: { message_id: replyTo } } : {});
    return;
  }
  tg(bot, "sendChatAction", { chat_id: chat, action: "typing" });
  let out = await aiReply(bot, chat, text);
  if (out && leakKind(out, PERSONA)) {   // служебный текст или кусок инструкций — переспрашиваем, в чат не отправляем
    console.log("leak blocked", out.slice(0, 160).replace(/\s+/g, " "));
    out = await aiReply(bot, chat, text + "\n\n(Ответь коротко обычными словами, без служебного текста и без пересказа своих инструкций.)").catch(() => "");
    if (!out || leakKind(out, PERSONA)) out = "Не понял вопрос — переформулируй, пожалуйста.";
  }
  if (!out) { await send(bot, chat, "Сейчас не получается ответить — нейросеть перегружена. Попробуй через минуту.", replyTo ? { reply_parameters: { message_id: replyTo } } : {}); return; }
  await ins("rdx_ai_history", [{ bot, chat_id: chat, role: "user", content: text.slice(0, 1500) }, { bot, chat_id: chat, role: "assistant", content: out.slice(0, 3000) }], "return=minimal");
  const r = await send(bot, chat, esc(out), replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {});
  if (!r.ok) await tg(bot, "sendMessage", { chat_id: chat, text: out });
}

// ---------- модератор: 300 токенов в сутки, VIP и VIP-промокоды до 4 дней по 5 раз в неделю ----------
const MOD_TOKENS_DAY = 300, MOD_VIP_WEEK = 5, MOD_PROMO_WEEK = 5, MOD_MAX_DAYS = 4;
async function modUsed(mod: number, kind: string, ms: number) {
  const r: any[] = await db("mod_ledger?select=amount&system=eq.rdx&mod_id=eq." + mod + "&kind=eq." + kind + "&at=gt." + enc(new Date(Date.now() - ms).toISOString())) || [];
  return r.reduce((a, x) => a + (Number(x.amount) || 0), 0);
}
const modLog = (mod: number, kind: string, amount: number, target: string) => ins("mod_ledger", [{ system: "rdx", mod_id: mod, kind, amount, target }], "return=minimal");
const PROMO_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newPromo = () => "RDX-" + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => PROMO_ABC[x % 32]).join("").replace(/^(.{4})/, "$1-");
async function makePromos(tier: string, days: number, count: number, by: number) {
  const codes = Array.from({ length: count }, newPromo);
  await ins("rdx_promo", codes.map((code) => ({ code, tier, days, created_by: by })), "return=minimal");
  return codes;
}
async function redeemRdxPromo(uid: number, raw: string) {
  const code = raw.toUpperCase().replace(/\s+/g, "");
  const pr = (await db("rdx_promo?select=*&code=eq." + enc(code)))?.[0];
  if (!pr) return "❌ Такого промокода RDX нет.";
  if (pr.used_by) return "❌ Этот промокод уже активирован.";
  const cur = await tierOf(uid, false);
  if (cur.tier !== "base" && higher(cur.tier, pr.tier) === cur.tier && cur.tier !== pr.tier) return "У тебя уже есть уровень выше (" + TIERS[cur.tier].name + "). Код не потрачен — можно отдать другу.";
  const from = cur.tier === pr.tier && cur.until ? Math.max(Date.now(), Date.parse(cur.until)) : Date.now();
  const until = new Date(from + Number(pr.days) * 86400e3).toISOString();
  const used = await db("rdx_promo?code=eq." + enc(code) + "&used_by=is.null", { method: "PATCH", body: JSON.stringify({ used_by: uid, used_at: new Date().toISOString() }), headers: { Prefer: "return=representation" } });
  if (!used?.length) return "❌ Этот промокод уже активирован.";
  await upsert("rdx_premium", [{ user_id: uid, tier: pr.tier, until, updated_at: new Date().toISOString() }], "user_id");
  return "🎉 Промокод активирован: <b>RDX_AI " + TIERS[pr.tier].name + "</b> до " + new Date(Date.parse(until) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " МСК.\nПроверить: /tokens";
}
const PROMO_RE = /\bRDX-[A-Z0-9]{4}-[A-Z0-9]{4}\b/i;

// ---------- состояние диалога ----------
async function getState(bot: Bot, uid: number) {
  const r = await db("rdx_state?select=flow,step,data&bot=eq." + bot + "&user_id=eq." + uid);
  return r?.[0] || null;
}
const setState = (bot: Bot, uid: number, flow: string | null, step = 0, data: unknown = {}) =>
  flow ? upsert("rdx_state", [{ bot, user_id: uid, flow, step, data, updated_at: new Date().toISOString() }], "bot,user_id") : del("rdx_state?bot=eq." + bot + "&user_id=eq." + uid);

// ---------- заявки ----------
const KIND: Record<string, string> = { apply: "📝 ЗАЯВКА В СКВАД", appeal: "⚖️ ОБЖАЛОВАНИЕ БАНА", help: "🆘 СООБЩЕНИЕ КОМАНДИРАМ", leave: "🚪 ЗАПРОС НА ВЫХОД" };
const WEAPONS = ["РПГ", "Гранатомёт", "Медик", "Ближний бой", "Револьверы", "Гранаты"];
const DEPTS = ["Экономика", "Штурм", "Наука"];   // отдел — только из этого списка
const DEPT_ICO: Record<string, string> = { "Экономика": "💰", "Штурм": "⚔️", "Наука": "🔬" };
const BASE_MEMBERS = 0;   // бойцов на сайте: 3 + принятые (закрытые) заявки − ушедшие
async function membersCount() { const r: any[] = await db("rdx_members?select=id&active=eq.true") || []; return BASE_MEMBERS + r.length; }
async function isMember(uid: number) { return !!(await db("rdx_members?select=id&active=eq.true&user_id=eq." + uid))?.[0]; }
const STATUS: Record<string, string> = { ok: "✅ <b>Одобрено</b> — проведи допрос при необходимости и нажми «Закрыть заявку»", no: "❌ <b>Отклонено</b>", closed: "🎖 <b>Закрыто — боец в составе</b>", reply: "💬 Отправлен ответ", left: "🚪 <b>Отпущен из сквада</b>", stay: "❌ <b>Выход отклонён</b>" };
function appText(a: any) {
  const d = a.data || {};
  const rows: [string, unknown][] = a.kind === "apply"
    ? [["Ник", d.nick], ["Telegram", d.tg ? "@" + d.tg : a.username ? "@" + a.username : ""], ["Возраст", d.age], ["Пояс", d.tz], ["Платформа", d.platform], ["Опыт", d.exp], ["Любимое оружие", d.weapon], ["Отдел", d.dept ? (DEPT_ICO[d.dept] || "") + " " + d.dept : ""], ["Почему RDX", d.why]]
    : a.kind === "appeal" ? [["Ник в игре", d.nick], ["За что бан", d.reason], ["Почему снять", d.why]] : a.kind === "leave" ? [["Причина", d.text]] : [["Сообщение", d.text]];
  return "<b>" + KIND[a.kind] + " #" + a.id + "</b> · " + (a.source === "site" ? "с сайта" : "из бота") + "\n"
    + (a.user_id ? "От: " + esc(d.from || "") + "\n" : "")
    + rows.filter(([, v]) => v).map(([k, v]) => "<b>" + k + ":</b> " + esc(v)).join("\n")
    + (a.edited_at ? "\n\n✏️ <i>Изменено заявителем " + new Date(Date.parse(a.edited_at) + 3 * 3600e3).toISOString().slice(5, 16).replace("T", " ") + " МСК</i>" : "")
    + (a.status && STATUS[a.status] ? "\n\n" + STATUS[a.status] : "");
}
function appButtons(a: any) {
  const id = a.id, st = a.status || "new";
  if (a.kind === "apply") {
    if (st === "new" || st === "reply") return kb([[["✅ Принять", "dec:" + id + ":ok"], ["❌ Отклонить", "dec:" + id + ":no"]], [["🕵️ Допрос", "dec:" + id + ":talk"], ["💬 Ответить", "dec:" + id + ":reply"]]]);
    if (st === "ok") return kb([[["🔒 Закрыть заявку", "dec:" + id + ":close"]], [["🕵️ Допрос", "dec:" + id + ":talk"], ["📜 Переписка", "dec:" + id + ":log"]]]);
    return kb([[["📜 Переписка", "dec:" + id + ":log"]]]);
  }
  if (a.kind === "leave") return st === "new" ? kb([[["✅ Отпустить", "dec:" + id + ":left"], ["❌ Оставить", "dec:" + id + ":stay"]], [["💬 Ответить", "dec:" + id + ":reply"]]]) : kb([]);
  if (st !== "new" && st !== "reply") return kb([[["💬 Ответить", "dec:" + id + ":reply"]]]);
  const ok = a.kind === "appeal" ? "✅ Снять бан" : "✅ Прочитано";
  const no = a.kind === "appeal" ? "❌ Оставить бан" : "❌ Отклонить";
  return kb([[[ok, "dec:" + id + ":ok"], [no, "dec:" + id + ":no"]], [["💬 Ответить", "dec:" + id + ":reply"]]]);
}
async function newApp(row: any) {
  const r = await ins("rdx_apps", [row]);
  const a = r?.[0];
  if (!a) return null;
  for (const id of await staff()) {
    const m = await send("main", id, appText(a), appButtons(a));
    if (m?.result?.message_id) await ins("rdx_app_msgs", [{ app_id: a.id, chat_id: id, message_id: m.result.message_id }], "return=minimal");
  }
  return a;
}
// обновить карточку заявки у всех командиров (после решения или правки с сайта)
async function refreshCards(a: any) {
  const msgs: any[] = await db("rdx_app_msgs?select=chat_id,message_id&app_id=eq." + a.id) || [];
  for (const m of msgs) await tg("main", "editMessageText", { chat_id: m.chat_id, message_id: m.message_id, text: appText(a), parse_mode: "HTML", reply_markup: appButtons(a).reply_markup });
}
const appUid = async (a: any) => a.user_id || (a.username ? (await db("rdx_users?select=user_id&started=eq.true&username=ilike." + enc(a.username)))?.[0]?.user_id : null);
// доставка решения: по user_id, а для заявок с сайта — когда человек откроет бота
async function deliver(a: any) {
  const uid = a.user_id || (a.username ? (await db("rdx_users?select=user_id,lang&started=eq.true&username=ilike." + enc(a.username)))?.[0]?.user_id : null);
  if (!uid) return false;
  const u = (await db("rdx_users?select=lang&user_id=eq." + uid))?.[0] || {};
  const lu = { language_code: u.lang || "ru" };
  const head = a.status === "ok" ? (a.kind === "apply" ? t(lu, "accepted") : a.kind === "appeal" ? t(lu, "ap_ok") : "") : a.status === "no" ? (a.kind === "apply" ? t(lu, "rejected") : a.kind === "appeal" ? t(lu, "ap_no") : "")
    : a.status === "closed" ? t(lu, "member") : a.status === "left" ? t(lu, "l_ok") : a.status === "stay" ? t(lu, "l_no") : "";
  const txt = [head, a.answer ? t(lu, "reply") + "\n" + esc(a.answer) : ""].filter(Boolean).join("\n\n");
  if (!txt) return true;
  const r = await send("main", uid, txt);
  if (r.ok) await patch("rdx_apps?id=eq." + a.id, { delivered: true, user_id: uid });
  return !!r.ok;
}

// ---------- состав клана: список, поиск по нику, бан, кик, увольнение ----------
const CLAN_BIG = 25, CLAN_PAGE = 20;
let BANS: { at: number; ids: Set<number>; names: Set<string> } | null = null;
async function isBanned(uid: number, username?: string | null) {
  if (!BANS || Date.now() - BANS.at > 30000) {
    const r: any[] = await db("rdx_bans?select=user_id,username") || [];
    BANS = { at: Date.now(), ids: new Set(r.filter((x) => x.user_id).map((x) => Number(x.user_id))), names: new Set(r.filter((x) => x.username).map((x) => String(x.username).toLowerCase())) };
  }
  return BANS.ids.has(Number(uid)) || (!!username && BANS.names.has(String(username).toLowerCase()));
}
const memName = (x: any) => (x.nick || x.username || "Боец") + (x.username ? " (@" + x.username + ")" : "");
const rankShort = (x: any) => (ADMINS.includes(Number(x.user_id)) ? "👑 Создатель" : RANKS[Number(x.rank) || 0]);
const clanAll = async (): Promise<any[]> => await db("rdx_members?select=id,user_id,username,nick,joined_at,app_id,rank,dept,weapon&active=eq.true&order=rank.desc,joined_at") || [];
const memRows = (list: any[]) => list.map((x) => [["🎖 " + (rankShort(x) + " · " + memName(x)).slice(0, 56), "cl:m:" + x.id]] as [string, string][]);
async function clanShow(chat: number, page: number | null) {
  const all = await clanAll(), big = all.length > CLAN_BIG;
  let text: string, rows: [string, string][][];
  if (!all.length) { text = "👥 В клане пока никого нет."; rows = []; }
  else if (page === null && big) {   // больше 25 — только число, поиск и кнопка «показать всех»
    text = "👥 <b>Состав клана RDX</b>\nВ строю: <b>" + all.length + "</b> бойцов.\nНайди бойца по нику или открой полный список.";
    rows = [[["🔎 Поиск по нику", "cl:find"]], [["📋 Показать всех", "cl:all:0"]]];
  } else {
    const pg = page || 0, part = big ? all.slice(pg * CLAN_PAGE, pg * CLAN_PAGE + CLAN_PAGE) : all;
    text = "👥 <b>Состав клана RDX</b> — в строю <b>" + all.length + "</b>" + (big ? " · стр. " + (pg + 1) + "/" + Math.ceil(all.length / CLAN_PAGE) : "") + "\nНажми на бойца, чтобы открыть карточку: бан, кик, увольнение.";
    rows = memRows(part);
    if (big) {
      const nav: [string, string][] = [];
      if (pg > 0) nav.push(["◀️ Назад", "cl:all:" + (pg - 1)]);
      if ((pg + 1) * CLAN_PAGE < all.length) nav.push(["Дальше ▶️", "cl:all:" + (pg + 1)]);
      if (nav.length) rows.push(nav);
      rows.push([["🔎 Поиск по нику", "cl:find"]]);
    }
  }
  rows.push([["↩️ Меню", "go:menu"]]);
  await send("main", chat, text, kb(rows));
}
async function clanFind(chat: number, q: string) {
  const s0 = q.replace(/^@/, "").trim().toLowerCase();
  const f = (await clanAll()).filter((x) => (x.nick || "").toLowerCase().includes(s0) || (x.username || "").toLowerCase().includes(s0)).slice(0, 20);
  const more: [string, string][][] = [[["🔎 Искать ещё", "cl:find"]], [["👥 Состав", "cl:list"]]];
  if (!f.length) return send("main", chat, "Никого не нашёл по «" + esc(q) + "».", kb(more));
  return send("main", chat, "🔎 Нашёл: <b>" + f.length + "</b>", kb([...memRows(f), ...more]));
}
async function clanCard(chat: number, id: number, ownerU = false) {
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active) return send("main", chat, "Этого бойца уже нет в составе.", kb([[["👥 Состав", "cl:list"]]]));
  const tr = x.user_id ? await tierOf(Number(x.user_id)) : null;
  const d = String(x.joined_at || "").slice(0, 10).split("-").reverse().join(".");
  const rk = Number(x.rank) || 0;
  const rows: [string, string][][] = [[["🚫 Бан", "cl:ask:ban:" + id], ["👢 Кик", "cl:ask:kick:" + id]], [["📄 Уволить (по заявлению)", "cl:ask:fire:" + id]]];
  if (ownerU) rows.unshift([["⬆️ Повысить", "cl:rk:" + id + ":up"], ["⬇️ Понизить", "cl:rk:" + id + ":down"]], [["🗂 Раздел", "cl:dp:" + id], ["🔫 Класс орудия", "cl:wp:" + id]]);
  if (isOwner({ id: chat })) rows.unshift([["🎯 Шанс на повышение", "cl:ch:" + id]]);
  rows.splice(rows.length - 1, 0, [["⚠️ Варн", "cl:ask:warn:" + id]]);
  rows.push([["👥 К списку", "cl:list"]]);
  await send("main", chat, "🎖 <b>" + esc(x.nick || "Боец") + "</b>" + (x.username ? " · @" + esc(x.username) : "") + "\nЗвание: <b>" + rankName(rk) + "</b>\nРаздел: <b>" + deptText(rk, x.dept, ADMINS.includes(Number(x.user_id))) + "</b>" + (weaponText(rk, x.weapon, ADMINS.includes(Number(x.user_id))) ? "\nКласс орудия: <b>" + esc(weaponText(rk, x.weapon, ADMINS.includes(Number(x.user_id)))) + "</b>" : "") + "\nКласс: <b>" + classOf(rk, x.dept, ADMINS.includes(Number(x.user_id))) + (x.weapon ? ", " + esc(x.weapon) : "") + "</b>" + (x.weapon ? "\nТип класса: <b>" + typeOf(rk, x.weapon, ADMINS.includes(Number(x.user_id))) + "</b>" : "") + "\nШанс на повышение: <b>" + (Number(x.promo_chance) || 0) + "%</b> · варны: <b>" + (x.user_id ? await warnCount(Number(x.user_id)) : 0) + "/5</b>\nВ составе с " + d + (x.app_id ? " · заявка #" + x.app_id : "")
    + (tr ? "\nУровень в ботах: " + (TIERS[tr.tier] || TIERS.base).name : "\nTelegram не привязан — сообщения от ботов ему не дойдут"), kb(rows));
}
const CLAN_ACT: Record<string, [string, string, string]> = {
  warn: ["⚠️ Выдать варн", "Варн: предупреждение на месяц. 5 активных варнов — автоматический бан.", "⚠️ получил варн"],
  ban: ["🚫 Забанить", "Бан: человек уйдёт из состава, а боты RDX, RDX_AI и SealsAI перестанут ему отвечать.", "🚫 забанен"],
  kick: ["👢 Кикнуть", "Кик: человек уйдёт из состава, бот напишет ему «Ты был выгнан из клана».", "👢 выгнан из клана"],
  fire: ["📄 Уволить", "Увольнение по заявлению: бот официально сообщит, что заявление рассмотрено и он уволен.", "📄 уволен"],
};
// история бойца (видна на сайте в аккаунте)
const hist = (uid: number, kind: string, text: string) => ins("rdx_history", [{ user_id: uid, kind, text: text.slice(0, 500) }], "return=minimal").catch(() => null);
async function warnCount(uid: number) {
  const r: any[] = await db("rdx_warns?select=id&user_id=eq." + uid + "&expires_at=gt." + enc(new Date().toISOString())) || [];
  return r.length;
}
// варн: создатель, модераторы и Админы; варн живёт месяц; 5 активных — бан
async function warnMember(actor: any, id: number, reason: string): Promise<{ ok: boolean; text: string }> {
  if (!(await isMod(actor))) return { ok: false, text: "Варны выдают создатель, модераторы и Админы." };
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active) return { ok: false, text: "Этого бойца нет в составе." };
  const tid = x.user_id ? Number(x.user_id) : null;
  if (!tid) return { ok: false, text: "У бойца не привязан Telegram — варн выдать нельзя." };
  if (ADMINS.includes(tid)) return { ok: false, text: "👑 Создателю варн не выдать." };
  if (tid === Number(actor.id)) return { ok: false, text: "Себе варн выдать нельзя." };
  if (!isOwner(actor) && (await modIds()).includes(tid)) return { ok: false, text: "Модератору варн выдаёт только создатель." };
  await ins("rdx_warns", [{ user_id: tid, member_id: id, by_id: Number(actor.id), reason: reason || null, expires_at: new Date(Date.now() + 30 * 86400e3).toISOString() }], "return=minimal");
  const n = await warnCount(tid);
  await hist(tid, "warn", "Предупреждение " + n + "/5" + (reason ? ": " + reason : "") + " (сгорит через месяц)");
  await notifyAny(tid, "⚠️ <b>Вам выдано предупреждение в RDX Squad</b> (" + n + " из 5)." + (reason ? "\nПричина: " + esc(reason) : "") + "\nПредупреждение сгорит через месяц. При 5 активных предупреждениях — бан.");
  if (!isOwner(actor)) for (const a of ADMINS) await send("main", a, "⚠️ Модератор " + who(actor) + " выдал варн: " + esc(memName(x)) + " (" + n + "/5)");
  if (n >= 5) {
    const b = await clanAct(actor, "ban", id);
    return { ok: true, text: esc(memName(x)) + " — 5/5 варнов. " + b.text };
  }
  return { ok: true, text: "⚠️ " + esc(memName(x)) + ": варн " + n + "/5 (сгорит через месяц)." };
}
// шанс на повышение 0–100% (только создатель)
async function setChance(actor: any, id: number, v: number): Promise<{ ok: boolean; text: string }> {
  if (!isOwner(actor)) return { ok: false, text: "Шанс на повышение ставит только создатель." };
  v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active) return { ok: false, text: "Этого бойца нет в составе." };
  await patch("rdx_members?id=eq." + id, { promo_chance: v });
  if (x.user_id) await hist(Number(x.user_id), "chance", "Шанс на повышение: " + v + "%");
  return { ok: true, text: "🎯 " + esc(memName(x)) + ": шанс на повышение — <b>" + v + "%</b>" };
}
// личное сообщение: сначала ботом RDX, если человек его не открывал — ботом SealsAI
async function notifyAny(uid: number, html: string) {
  const r: any = await send("main", uid, html);
  if (r?.ok) return true;
  const st = Deno.env.get("SEALSAI_BOT_TOKEN");
  if (!st) return false;
  const r2: any = await fetch("https://api.telegram.org/bot" + st + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: uid, text: html, parse_mode: "HTML" }) }).then((x) => x.json()).catch(() => null);
  return !!r2?.ok;
}
// присвоить звание (только создатель); человеку — поздравление и новые возможности
async function setRank(actor: any, id: number, k: number): Promise<{ ok: boolean; text: string }> {
  const ownerA = isOwner(actor), adminA = !ownerA && await isRankAdmin(actor);
  if (!ownerA && !adminA) return { ok: false, text: "Звания меняют только создатель и Админы." };
  k = Math.round(Number(k));
  if (!(k >= 0 && k <= TOP_RANK)) return { ok: false, text: "Звания — от 0 (Рядовой) до 14 (Админ)." };
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active) return { ok: false, text: "Этого бойца нет в составе." };
  const old = Number(x.rank) || 0;
  if (x.user_id && ADMINS.includes(Number(x.user_id))) return { ok: false, text: "👑 Создателю звание не нужно." };
  if (adminA && (k > MARSHAL_RANK || old > MARSHAL_RANK)) return { ok: false, text: "Админ меняет звания только до Маршала. Модератора и Админа назначает создатель." };
  if (adminA && Number(x.user_id) === Number(actor.id)) return { ok: false, text: "Себе звание менять нельзя." };
  if (old === k) return { ok: true, text: esc(memName(x)) + " уже " + rankName(k) + "." };
  await patch("rdx_members?id=eq." + id, k > old ? { rank: k, promo_chance: 0 } : { rank: k });
  if (x.user_id) await hist(Number(x.user_id), k > old ? "rank_up" : "rank_down", (k > old ? "Повышение: " : "Понижение: ") + RANKS[old] + " → " + RANKS[k] + " (" + k + "/" + TOP_RANK + ")");
  // Модератор (13) и Админ (14) — сразу модераторы RDX и SealsAI; ниже — права модератора снимаются
  if (x.user_id && k >= MOD_RANK) { await upsert("rdx_mods", [{ user_id: Number(x.user_id), username: x.username || null, first_name: x.nick || null, added_at: new Date().toISOString() }], "user_id"); MODS = null; }
  if (x.user_id && k < MOD_RANK && old >= MOD_RANK) { await del("rdx_mods?user_id=eq." + Number(x.user_id)); MODS = null; }
  let sent = false;
  if (x.user_id) sent = await notifyAny(Number(x.user_id), (k > old
    ? "🎖 <b>Поздравляем!</b>\nКомандование RDX Squad присвоило вам звание <b>«" + RANKS[k] + "»</b> (" + k + " из " + TOP_RANK + "). Благодарим за службу — так держать!"
    : "🎖 Ваше звание в RDX Squad изменено на <b>«" + RANKS[k] + "»</b> (" + k + " из " + TOP_RANK + ").")
    + "\n\n<b>Ваши возможности теперь:</b>\n" + rankPerks(k));
  return { ok: true, text: (k > old ? "⬆️ " : "⬇️ ") + esc(memName(x)) + ": " + RANKS[old] + " → <b>" + rankName(k) + "</b>" + (x.user_id ? (sent ? " · поздравление отправлено" : " · сообщение не дошло (не писал ботам)") : " · Telegram не привязан") };
}
// сменить раздел или класс орудия (создатель и Админ); человеку — уведомление
async function setClass(actor: any, id: number, field: "dept" | "weapon", value: string): Promise<{ ok: boolean; text: string }> {
  if (!isOwner(actor) && !(await isRankAdmin(actor))) return { ok: false, text: "Раздел и класс меняют только создатель и Админы." };
  value = String(value || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 40);
  if (field === "dept") {
    const d = DEPTS.find((x) => x.toLowerCase().slice(0, 4) === value.toLowerCase().replace(/ё/g, "е").slice(0, 4));
    if (!d) return { ok: false, text: "Разделы: Экономика, Штурм, Наука." };
    value = d;
  }
  if (!value) return { ok: false, text: "Пустое значение." };
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active) return { ok: false, text: "Этого бойца нет в составе." };
  if (x[field] === value) return { ok: true, text: esc(memName(x)) + ": уже " + esc(value) + "." };
  await patch("rdx_members?id=eq." + id, { [field]: value });
  if (x.user_id) await hist(Number(x.user_id), field, field === "dept" ? "Перевод в раздел: " + value : "Класс орудия: " + value);
  const rk = Number(x.rank) || 0, nd = field === "dept" ? value : x.dept, nw = field === "weapon" ? value : x.weapon;
  const cls = classOf(rk, nd, ADMINS.includes(Number(x.user_id))) + (nw ? ", " + nw : "");
  let sent = false;
  if (x.user_id) sent = await notifyAny(Number(x.user_id), field === "dept"
    ? "🗂 <b>Вас перевели в раздел «" + esc(value) + "»</b> RDX Squad.\nВаш класс теперь: <b>" + esc(cls) + "</b>."
    : "🔫 Ваш класс орудия в RDX Squad теперь: <b>" + esc(value) + "</b>.\nВаш класс: <b>" + esc(cls) + "</b>.");
  return { ok: true, text: (field === "dept" ? "🗂 " : "🔫 ") + esc(memName(x)) + ": " + (field === "dept" ? "раздел" : "класс орудия") + " → <b>" + esc(value) + "</b> · класс: " + esc(cls) + (x.user_id ? (sent ? " · уведомление отправлено" : "") : "") };
}
const RANK_WORDS: [RegExp, number][] = [[/^рядов/, 0], [/^ефрейт/, 1], [/^младш/, 2], [/^сержант/, 3], [/^старшин/, 4], [/^прапор/, 5], [/^лейтенант/, 6], [/^капитан/, 8], [/^майор/, 9], [/^полковн/, 10], [/^генерал/, 11], [/^маршал/, 12], [/^модер/, 13], [/^админ/, 14]];
// действие над бойцом: ban | kick | fire. actor — кто просит (создатель или модератор)
async function clanAct(actor: any, act: string, id: number): Promise<{ ok: boolean; text: string }> {
  if (act === "warn") return await warnMember(actor, id, "");
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active || !CLAN_ACT[act]) return { ok: false, text: "Этого бойца уже нет в составе." };
  if (!(await isMod(actor))) return { ok: false, text: "Это могут только создатель и модераторы RDX." };
  const tid = x.user_id ? Number(x.user_id) : null;
  if ((tid && ADMINS.includes(tid)) || /^mr_wugi4$/i.test(x.username || "")) return { ok: false, text: "👑 Создателя убрать нельзя." };
  if (tid === Number(actor.id)) return { ok: false, text: "Себя убрать нельзя — подай заявление на выход через меню бота RDX." };
  if (!isOwner(actor) && tid && (await modIds()).includes(tid)) return { ok: false, text: "Модератора может убрать только создатель." };
  await patch("rdx_members?id=eq." + id, { active: false, left_at: new Date().toISOString() });
  if (act === "ban") { await ins("rdx_bans", [{ user_id: tid, username: x.username || null, nick: x.nick || null, by_id: Number(actor.id) }], "return=minimal"); BANS = null; if (tid) await patch("rdx_sessions?user_id=eq." + tid, { revoked: true }); }
  if (tid && act !== "ban") await hist(tid, act, act === "kick" ? "Выгнан из клана" : "Уволен по заявлению");
  if (act === "fire" && tid) {   // открытое заявление на выход — закрываем
    const lv: any[] = await db("rdx_apps?select=*&kind=eq.leave&status=eq.new&user_id=eq." + tid) || [];
    for (const a of lv) { await patch("rdx_apps?id=eq." + a.id, { status: "left", decided_by: String(actor.id), decided_at: new Date().toISOString() }); await refreshCards({ ...a, status: "left" }); }
  }
  if (tid) {
    const lu = { language_code: (await db("rdx_users?select=lang&user_id=eq." + tid))?.[0]?.lang || "ru" };
    await send("main", tid, t(lu, act === "ban" ? "bannedm" : act === "kick" ? "kicked" : "l_ok"));
  }
  const line = esc(memName(x)) + " — " + CLAN_ACT[act][2] + ".";
  if (!isOwner(actor)) for (const a of ADMINS) await send("main", a, "🛡 Модератор " + who(actor) + ": " + line);
  return { ok: true, text: line + " Бойцов теперь: <b>" + await membersCount() + "</b>" };
}
async function clanDo(u: any, chat: number, act: string, id: number) {
  const r = await clanAct(u, act, id);
  await send("main", chat, r.text, kb([[["👥 Состав", "cl:list"]]]));
}
// поиск бойца по нику, @нику или имени в любом падеже («Аркадия», «Глебу»), с опечатками
const lev = (a: string, b: string) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
async function findMembers(q: string): Promise<any[]> {
  const all = await clanAll();
  const raw = String(q || "").trim();
  if (/^id:\d+$/.test(raw)) return all.filter((x) => String(x.user_id) === raw.slice(3));
  const n = (v: string) => String(v || "").toLowerCase().replace(/ё/g, "е").replace(/^@/, "");
  const w = n(raw.split(/\s+/)[0]);
  if (!w) return [];
  const exact = all.filter((x) => n(x.username) === w || n(x.nick) === w);
  if (exact.length) return exact;
  const stem = w.length > 4 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w;
  const st = all.filter((x) => [n(x.username), n(x.nick)].some((v) => v && (v.startsWith(stem) || v.includes(w))));
  if (st.length) return st;
  return all.filter((x) => [n(x.username), n(x.nick)].some((v) => v && lev(v.slice(0, w.length + 1), w) <= 2));
}
const memLine = (x: any) => "• " + esc(rankShort(x)) + " · " + esc(x.nick || "Боец") + " — " + esc(classOf(Number(x.rank) || 0, x.dept, ADMINS.includes(Number(x.user_id))) + (x.weapon ? ", " + x.weapon : "")) + (x.username ? " (@" + esc(x.username) + ")" : "") + (x.user_id ? "" : " — Telegram не привязан");
// общий вход: list | find | ban | kick | fire (для RDX_AI и SealsAI)
async function clanApi(actor: any, act: string, q: string, rank?: number | null, value?: string | null): Promise<{ ok: boolean; text: string }> {
  if (act === "list") {
    const all = await clanAll();
    if (all.length > CLAN_BIG) return { ok: true, text: "👥 В строю клана RDX: <b>" + all.length + "</b>. Полный список — кнопка «👥 Состав клана» в боте RDX." };
    return { ok: true, text: "👥 <b>Состав клана RDX</b> — в строю " + all.length + ":\n" + all.map(memLine).join("\n") };
  }
  const f = await findMembers(q);
  if (act === "find") return f.length ? { ok: true, text: "🔎 Нашёл в составе:\n" + f.slice(0, 20).map(memLine).join("\n") } : { ok: false, text: "В составе RDX нет никого по «" + esc(q) + "»." };
  if (!CLAN_ACT[act] && !["rank", "promote", "demote", "dept", "weapon"].includes(act)) return { ok: false, text: "Не понял действие." };
  if (!f.length) return { ok: false, text: "В составе RDX нет никого по «" + esc(q) + "»." };
  if (f.length > 1) return { ok: false, text: "Под «" + esc(q) + "» подходят несколько бойцов — уточни ник:\n" + f.slice(0, 10).map(memLine).join("\n") };
  if (act === "dept" || act === "weapon") return await setClass(actor, Number(f[0].id), act, String(value || ""));
  if (act === "warn") return await warnMember(actor, Number(f[0].id), String(value || ""));
  if (act === "rank" || act === "promote" || act === "demote") {
    const cur = Number(f[0].rank) || 0;
    const k = rank !== null && rank !== undefined && !Number.isNaN(Number(rank)) ? Number(rank) : act === "promote" ? cur + 1 : act === "demote" ? cur - 1 : NaN;
    return await setRank(actor, Number(f[0].id), k);
  }
  return await clanAct(actor, act, Number(f[0].id));
}
// просьба обычными словами в RDX_AI: «забань Аркадия», «кикни @ник», «уволь Глеба», «найди Никиту», «кто в составе»
async function clanIntent(u: any, text: string): Promise<string | null> {
  const tl = text.toLowerCase().replace(/ё/g, "е");
  const verbs: [RegExp, string][] = [[/(^|\s)(забан\S*|бан|заблокир\S*)(\s|$)/, "ban"], [/(^|\s)(кикн\S*|кик|выгон\S*|выгна\S*|выкин\S*)(\s|$)/, "kick"], [/(^|\s)(уволь\S*|уволи\S*)(\s|$)/, "fire"], [/(^|\s)(найди|найти|поищи|ищи)(\s|$)/, "find"]];
  verbs.unshift([/(^|\s)(повыс\S*|повысить)(\s|$)/, "promote"], [/(^|\s)(пониз\S*|понизить)(\s|$)/, "demote"], [/(^|\s)(переведи|перевести|переведите)(\s|$)/, "dept"]);
  {   // «класс орудия Глебу — гранатомёт», «поставь Аркадию класс орудия револьверы»
    const wm = text.match(/класс\s+оруди[яе]\s*(?:у|для)?\s*@?([A-Za-zА-Яа-яЁё0-9_]{2,32})\s*[:—-]?\s*(.{2,40})$/i) || text.match(/@?([A-Za-zА-Яа-яЁё0-9_]{2,32})\s+класс\s+оруди[яе]\s*[:—-]?\s*(.{2,40})$/i);
    if (wm && (isOwner(u) || await isRankAdmin(u)) && (await findMembers(wm[1])).length === 1) return (await clanApi(u, "weapon", wm[1], null, wm[2].trim())).text;
  }
  let act = "", vm: RegExpMatchArray | null = null;
  for (const [re, a] of verbs) { const m = tl.match(re); if (m) { act = a; vm = m; break; } }
  const aboutClan = /(клан|состав|сквад|склад|rdx|рдх|строю)/.test(tl);
  if (!act && aboutClan && /(кто|список|покажи|сколько)/.test(tl)) act = "list";
  if (!act || (act === "find" && !aboutClan && !/@\w/.test(text))) return null;
  if (act === "list") return (await clanApi(u, "list", "")).text;
  const at = text.match(/@([A-Za-z0-9_]{3,32})/);
  const words = tl.slice((vm!.index || 0) + vm![0].length).split(/[\s,.!?]+/).filter(Boolean);
  // звание после «до»: число 0–12 или название («до маршала», «до младшего сержанта»)
  let rank: number | null = null;
  const di = words.indexOf("до");
  if (di >= 0) {
    const w1 = words[di + 1] || "", w2 = words[di + 2] || "";
    if (/^\d{1,2}$/.test(w1)) rank = Number(w1);
    else if (/^старш/.test(w1) && /^лейтенант/.test(w2)) rank = 7;
    else for (const [re, k] of RANK_WORDS) if (re.test(w1)) { rank = k; break; }
  }
  const skip = new Set<number>(di >= 0 ? [di, di + 1, di + 2] : []);
  const after = words.filter((w, i) => !skip.has(i) && !/^(из|с|со|клана|клане|состава|составе|сквада|скваде|склада|скаде|rdx|рдх|пожалуйста|плиз|игрока|бойца|его|ее|этого|мне|нам|звание|звания|в|во|на|раздел|отдел|экономику|экономика|штурм|науку|наука)$/.test(w));
  const q = at ? at[1] : after[0] || "";
  if (!q) return null;   // «как обжаловать бан?» — это вопрос, а не просьба
  if (!at && !(await findMembers(q)).length) return null;
  if ((act === "promote" || act === "demote" || act === "dept") && !isOwner(u) && !(await isRankAdmin(u))) return "Звания и разделы меняют только создатель и Админы.";
  if (act === "dept") {
    const dm = tl.match(/(экономик|штурм|наук)/);
    if (!dm) return null;
    return (await clanApi(u, "dept", q, null, dm[1])).text;
  }
  if (act !== "find" && !(await isMod(u))) return "Банить, кикать и увольнять из клана могут только создатель и модераторы RDX.";
  return (await clanApi(u, act, q, rank)).text;
}

// ---------- бот RDX ----------
function menu(u: any, member = false, staffU = false) {
  return kb([[member ? [t(u, "leave"), "go:leave"] : [t(u, "apply"), "go:apply"]], [[t(u, "appeal"), "go:appeal"], [t(u, "help"), "go:help"]], [[t(u, "ai"), "go:ai"], [t(u, "site"), "app:" + SITE_APP]],
    ...(staffU ? [[[t(u, "clan"), "cl:list"]]] as [string, string][][] : [])]);
}
const PLAT = ["Quest 3/3S", "Quest 2", "Quest Pro", "PC VR"];
async function startFlow(u: any, chat: number, flow: string) {
  if (flow === "ai") { await setState("main", u.id, "ai"); await send("main", chat, t(u, "ai_on"), kb([[[t(u, "menu"), "go:menu"]]])); return; }
  if (flow === "apply") { await setState("main", u.id, "apply", 0, {}); await send("main", chat, t(u, "a_nick"), kb([[[t(u, "cancel"), "go:menu"]]])); return; }
  if (flow === "appeal") { await setState("main", u.id, "appeal", 0, {}); await send("main", chat, t(u, "p_nick"), kb([[[t(u, "cancel"), "go:menu"]]])); return; }
  if (flow === "help") { await setState("main", u.id, "help", 0, {}); await send("main", chat, t(u, "h_ask"), kb([[[t(u, "cancel"), "go:menu"]]])); return; }
  const member = await isMember(u.id);
  if (flow === "leave") {
    if (!member) { await send("main", chat, t(u, "l_not"), menu(u, false)); return; }
    await setState("main", u.id, "leave", 0, {}); await send("main", chat, t(u, "l_ask"), kb([[[t(u, "cancel"), "go:menu"]]])); return;
  }
  await setState("main", u.id, null);
  await send("main", chat, t(u, "hello"), menu(u, member, await isMod(u)));
}
async function flowStep(u: any, chat: number, st: any, text: string) {
  const d = st.data || {};
  if (text.length > 1000) { await send("main", chat, t(u, "toolong")); return; }
  const cancel = kb([[[t(u, "cancel"), "go:menu"]]]);
  if (st.flow === "apply") {
    if (st.step === 0) { d.nick = text.slice(0, 40); await setState("main", u.id, "apply", 1, d); await send("main", chat, t(u, "a_age"), cancel); return; }
    if (st.step === 1) { d.age = text.slice(0, 3); await setState("main", u.id, "apply", 2, d); await send("main", chat, t(u, "a_plat"), kb([PLAT.slice(0, 2).map((p) => [p, "pl:" + p]) as any, PLAT.slice(2).map((p) => [p, "pl:" + p]) as any, [[t(u, "cancel"), "go:menu"]]])); return; }
    if (st.step === 2) { d.platform = text.slice(0, 30); await setState("main", u.id, "apply", 3, d); await askExp(u, chat); return; }
    if (st.step === 3) { d.exp = text.slice(0, 30); await setState("main", u.id, "apply", 4, d); await send("main", chat, t(u, "a_wpn"), kb([[[WEAPONS[0], "wp:0"], [WEAPONS[1], "wp:1"]], [[WEAPONS[2], "wp:2"], [WEAPONS[3], "wp:3"]], [[WEAPONS[4], "wp:4"], [WEAPONS[5], "wp:5"]], [[t(u, "cancel"), "go:menu"]]])); return; }
    if (st.step === 4) { d.weapon = text.slice(0, 40); await setState("main", u.id, "apply", 5, d); await askDept(u, chat); return; }
    if (st.step === 5) {
      if (!DEPTS.includes(text)) { await send("main", chat, t(u, "a_depreq")); await askDept(u, chat); return; }
      d.dept = text; await setState("main", u.id, "apply", 6, d); await send("main", chat, t(u, "a_why"), cancel); return;
    }
    if (st.step === 6) { d.why = text.slice(0, 1000); await setState("main", u.id, "apply", 7, d); await confirm(u, chat, "apply", d); return; }
  }
  if (st.flow === "appeal") {
    if (st.step === 0) { d.nick = text.slice(0, 40); await setState("main", u.id, "appeal", 1, d); await send("main", chat, t(u, "p_reason"), cancel); return; }
    if (st.step === 1) { d.reason = text.slice(0, 600); await setState("main", u.id, "appeal", 2, d); await send("main", chat, t(u, "p_why"), cancel); return; }
    if (st.step === 2) { d.why = text.slice(0, 1000); await setState("main", u.id, "appeal", 3, d); await confirm(u, chat, "appeal", d); return; }
  }
  if (st.flow === "help") { d.text = text.slice(0, 1000); await setState("main", u.id, "help", 1, d); await confirm(u, chat, "help", d); return; }
  if (st.flow === "leave") { d.text = text.slice(0, 1000); await setState("main", u.id, "leave", 1, d); await confirm(u, chat, "leave", d); return; }
  if (st.flow === "talk" && await isMod(u)) {   // командир ведёт допрос: сообщение уходит человеку
    const a = (await db("rdx_apps?select=*&id=eq." + Number(d.id)))?.[0];
    const uid = a ? await appUid(a) : null;
    if (!a || !uid) { await send("main", chat, "Человек ещё не открыл бота — написать ему пока нельзя."); return; }
    const lu = (await db("rdx_users?select=lang&user_id=eq." + uid))?.[0] || {};
    const r = await send("main", uid, t({ language_code: lu.lang || "ru" }, "cmdr") + "\n" + esc(text));
    await ins("rdx_talks", [{ app_id: a.id, dir: "out", by_name: u.first_name || "", text: text.slice(0, 2000) }], "return=minimal");
    if (!r.ok) await send("main", chat, "Не доставлено: " + esc(r.description || "ошибка"));
    return;
  }
  if (st.flow === "reply" && await isMod(u)) {   // командир пишет ответ на заявку
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
async function askDept(u: any, chat: number) {
  const lab = (i: number) => DEPT_ICO[DEPTS[i]] + " " + (({ en: ["Economy", "Assault", "Science"], uk: ["Економіка", "Штурм", "Наука"] } as any)[L(u)]?.[i] || DEPTS[i]);
  await send("main", chat, t(u, "a_dep"), kb([[[lab(0), "dp:0"], [lab(1), "dp:1"]], [[lab(2), "dp:2"]], [[t(u, "cancel"), "go:menu"]]]));
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
    if (!isOwner(u) && await isBanned(u.id, u.username)) return;
    if (data.startsWith("go:")) return startFlow(u, chat, data.slice(3));
    if (data === "acc:kill") {
      await patch("rdx_sessions?user_id=eq." + u.id + "&revoked=eq.false", { revoked: true });
      await hist(u.id, "security", "Все входы на сайт сброшены из Telegram");
      return send("main", chat, "🚫 Все входы в твой аккаунт на сайте RDX сброшены. Заходи заново — код придёт сюда.");
    }
    const st = await getState("main", u.id);
    if (data.startsWith("cl:")) {
      if (!(await isMod(u))) return;
      const [, op, a1, a2] = data.split(":");
      if (st?.flow === "clfind" && op !== "find") await setState("main", u.id, null);
      if (op === "list") return clanShow(chat, null);
      if (op === "all") return clanShow(chat, Number(a1) || 0);
      if (op === "find") { await setState("main", u.id, "clfind", 0, {}); return send("main", chat, "🔎 Напиши ник бойца или его часть:", kb([[["✖️ Отмена", "cl:list"]]])); }
      if (op === "m") return clanCard(chat, Number(a1), isOwner(u) || await isRankAdmin(u));
      if (op === "rk") {   // выбор нового звания кнопками
        const ownerR = isOwner(u);
        if (!ownerR && !(await isRankAdmin(u))) return send("main", chat, "Звания меняют только создатель и Админы.");
        const x = (await db("rdx_members?select=nick,username,rank,active&id=eq." + Number(a1)))?.[0];
        if (!x?.active) return send("main", chat, "Этого бойца уже нет в составе.");
        const cur = Number(x.rank) || 0, up = a2 === "up";
        const maxK = ownerR ? TOP_RANK : MARSHAL_RANK;
        if (!ownerR && cur > MARSHAL_RANK) return send("main", chat, "Модератора и Админа повышает и понижает только создатель.");
        const ks = RANKS.map((_, k) => k).filter((k) => k <= maxK && (up ? k > cur : k < cur));
        if (!ks.length) return send("main", chat, up ? "Выше званий нет." : "Ниже Рядового званий нет.", kb([[["↩️ Назад", "cl:m:" + Number(a1)]]]));
        const grid: [string, string][][] = [];
        for (let i = 0; i < ks.length; i += 2) grid.push(ks.slice(i, i + 2).map((k) => [k + " · " + RANKS[k], "cl:set:" + Number(a1) + ":" + k] as [string, string]));
        grid.push([["↩️ Назад", "cl:m:" + Number(a1)]]);
        return send("main", chat, (up ? "⬆️ Повысить" : "⬇️ Понизить") + " <b>" + esc(memName(x)) + "</b>\nСейчас: " + rankName(cur) + ". До какого звания?", kb(grid));
      }
      if (op === "dp" || op === "wp") {   // выбор раздела / класса орудия кнопками
        if (!isOwner(u) && !(await isRankAdmin(u))) return send("main", chat, "Раздел и класс меняют только создатель и Админы.");
        const x = (await db("rdx_members?select=nick,username,dept,weapon,active&id=eq." + Number(a1)))?.[0];
        if (!x?.active) return send("main", chat, "Этого бойца уже нет в составе.");
        const opts = op === "dp" ? DEPTS : WEAPONS;
        const grid: [string, string][][] = [];
        for (let i = 0; i < opts.length; i += 2) grid.push(opts.slice(i, i + 2).map((v, j) => [(op === "dp" ? (DEPT_ICON[v] || "") + " " : "") + v, "cl:" + (op === "dp" ? "sd" : "sw") + ":" + Number(a1) + ":" + (i + j)] as [string, string]));
        if (op === "wp") grid.push([["✍️ Своё (написать)", "cl:wc:" + Number(a1)]]);
        grid.push([["↩️ Назад", "cl:m:" + Number(a1)]]);
        return send("main", chat, (op === "dp" ? "🗂 Раздел для <b>" + esc(memName(x)) + "</b>\nСейчас: " + (x.dept || "не выбран") : "🔫 Класс орудия для <b>" + esc(memName(x)) + "</b>\nСейчас: " + esc(x.weapon || "не выбран")), kb(grid));
      }
      if (op === "sd" || op === "sw") {
        await tg("main", "editMessageReplyMarkup", { chat_id: chat, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
        const r = await setClass(u, Number(a1), op === "sd" ? "dept" : "weapon", (op === "sd" ? DEPTS : WEAPONS)[Number(a2)] || "");
        return send("main", chat, r.text, kb([[["🎖 Карточка", "cl:m:" + Number(a1)], ["👥 Состав", "cl:list"]]]));
      }
      if (op === "wc") {
        if (!isOwner(u) && !(await isRankAdmin(u))) return;
        await setState("main", u.id, "clweapon", 0, { id: Number(a1) });
        return send("main", chat, "✍️ Напиши класс орудия одним сообщением (до 40 символов):", kb([[["✖️ Отмена", "cl:m:" + Number(a1)]]]));
      }
      if (op === "set") {
        await tg("main", "editMessageReplyMarkup", { chat_id: chat, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
        const r = await setRank(u, Number(a1), Number(a2));
        return send("main", chat, r.text, kb([[["🎖 Карточка", "cl:m:" + Number(a1)], ["👥 Состав", "cl:list"]]]));
      }
      if (op === "ask" && CLAN_ACT[a1]) {
        const x = (await db("rdx_members?select=nick,username,active&id=eq." + Number(a2)))?.[0];
        if (!x?.active) return send("main", chat, "Этого бойца уже нет в составе.");
        return send("main", chat, CLAN_ACT[a1][0] + " <b>" + esc(memName(x)) + "</b>?\n" + CLAN_ACT[a1][1], kb([[["✅ Да", "cl:do:" + a1 + ":" + Number(a2)], ["✖️ Нет", "cl:m:" + Number(a2)]]]));
      }
      if (op === "do") {
        await tg("main", "editMessageReplyMarkup", { chat_id: chat, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
        if (a1 === "warn") { const r = await warnMember(u, Number(a2), ""); return send("main", chat, r.text, kb([[["🎖 Карточка", "cl:m:" + Number(a2)], ["👥 Состав", "cl:list"]]])); }
        return clanDo(u, chat, a1, Number(a2));
      }
      if (op === "ch") {   // шанс на повышение (только создатель)
        if (!isOwner(u)) return;
        const grid: [string, string][][] = [];
        for (let v = 0; v <= 100; v += 30) grid.push([0, 10, 20].filter((d0) => v + d0 <= 100).map((d0) => [(v + d0) + "%", "cl:cs:" + Number(a1) + ":" + (v + d0)] as [string, string]));
        grid.push([["100%", "cl:cs:" + Number(a1) + ":100"]], [["↩️ Назад", "cl:m:" + Number(a1)]]);
        return send("main", chat, "🎯 Шанс на повышение — от 0 до 100%. Его видно на сайте в аккаунте бойца.", kb(grid));
      }
      if (op === "cs") {
        if (!isOwner(u)) return;
        const r = await setChance(u, Number(a1), Number(a2));
        return send("main", chat, r.text, kb([[["🎖 Карточка", "cl:m:" + Number(a1)], ["👥 Состав", "cl:list"]]]));
      }
      return;
    }
    if (data.startsWith("pl:") && st?.flow === "apply" && st.step === 2) return flowStep(u, chat, st, data.slice(3));
    if (data.startsWith("ex:") && st?.flow === "apply" && st.step === 3) return flowStep(u, chat, st, data.slice(3));
    if (data.startsWith("wp:") && st?.flow === "apply" && st.step === 4) return flowStep(u, chat, st, WEAPONS[Number(data.slice(3))] || "");
    if (data.startsWith("dp:") && st?.flow === "apply" && st.step === 5) return flowStep(u, chat, st, DEPTS[Number(data.slice(3))] || "");
    if (data.startsWith("sub:") && st && st.flow === data.slice(4)) {
      await setState("main", u.id, null);
      const kind = st.flow;
      await newApp({ kind, source: "bot", user_id: u.id, username: u.username || null, data: { ...st.data, from: (u.first_name || "") + (u.username ? " @" + u.username : "") + " · id " + u.id } });
      await tg("main", "editMessageReplyMarkup", { chat_id: chat, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
      await send("main", chat, t(u, kind === "apply" ? "a_done" : kind === "appeal" ? "p_done" : kind === "leave" ? "l_done" : "h_done"), menu(u, await isMember(u.id), await isMod(u)));
      return;
    }
    if (data.startsWith("dec:")) {
      if (!(await isMod(u))) return tg("main", "answerCallbackQuery", { callback_query_id: c.id, text: t(u, "nope"), show_alert: true });
      const [, id, act] = data.split(":");
      const a = (await db("rdx_apps?select=*&id=eq." + Number(id)))?.[0];
      if (!a) return;
      if (act === "reply") { await setState("main", u.id, "reply", 0, { id: a.id }); await send("main", chat, "Напиши ответ на #" + a.id + " одним сообщением:", kb([[["✖️ Отмена", "go:menu"]]])); return; }
      if (act === "talk") {
        const uid = await appUid(a);
        if (!uid) { await send("main", chat, "⏳ Человек ещё не открыл бота — допрос начнётся, когда он нажмёт «Старт». Попробуй позже."); return; }
        await patch("rdx_apps?id=eq." + a.id, { talk_open: true, talk_by: u.id, user_id: uid });
        await setState("main", u.id, "talk", 0, { id: a.id });
        const lu = (await db("rdx_users?select=lang&user_id=eq." + uid))?.[0] || {};
        await send("main", uid, t({ language_code: lu.lang || "ru" }, "talk_on"));
        await send("main", chat, "🕵️ <b>Допрос по заявке #" + a.id + "</b> (" + esc(a.data?.nick || "") + ")\nПиши сообщения — бот перешлёт их человеку. Ответы придут сюда.", kb([[["📜 Переписка", "dec:" + a.id + ":log"], ["⏹ Завершить", "dec:" + a.id + ":endtalk"]]]));
        return;
      }
      if (act === "endtalk") {
        await patch("rdx_apps?id=eq." + a.id, { talk_open: false });
        await setState("main", u.id, null);
        const uid = await appUid(a);
        if (uid) { const lu = (await db("rdx_users?select=lang&user_id=eq." + uid))?.[0] || {}; await send("main", uid, t({ language_code: lu.lang || "ru" }, "talk_off")); }
        await send("main", chat, "⏹ Допрос по #" + a.id + " завершён.", appButtons(a)); return;
      }
      if (act === "log") {
        const r: any[] = await db("rdx_talks?select=dir,by_name,text,created_at&app_id=eq." + a.id + "&order=created_at.asc&limit=60") || [];
        const tm = (x: string) => new Date(Date.parse(x) + 3 * 3600e3).toISOString().slice(11, 16);
        await send("main", chat, r.length ? "<b>📜 Переписка по #" + a.id + "</b>\n\n" + r.map((x) => tm(x.created_at) + " " + (x.dir === "out" ? "🎖 " + esc(x.by_name || "командир") : "👤 " + esc(a.data?.nick || "заявитель")) + ": " + esc(x.text)).join("\n").slice(0, 3900) : "Переписки по #" + a.id + " ещё нет.");
        return;
      }
      if (act === "close") {
        if (a.status !== "ok") return;
        const uid = await appUid(a);
        await ins("rdx_members", [{ user_id: uid, username: a.username || a.data?.tg || null, nick: a.data?.nick || null, app_id: a.id, active: true, dept: DEPTS.includes(a.data?.dept) ? a.data.dept : null, weapon: a.data?.weapon || null }], "return=minimal");
        await patch("rdx_apps?id=eq." + a.id, { status: "closed", talk_open: false, decided_by: String(u.id), decided_at: new Date().toISOString() });
        const na = { ...a, status: "closed" };
        await deliver(na); await refreshCards(na);
        await send("main", chat, "🎖 " + esc(a.data?.nick || "Боец") + " в составе. Бойцов теперь: <b>" + await membersCount() + "</b>"); return;
      }
      if (act === "left" || act === "stay") {
        if (act === "left") await patch("rdx_members?active=eq.true&user_id=eq." + a.user_id, { active: false, left_at: new Date().toISOString() });
        await patch("rdx_apps?id=eq." + a.id, { status: act, decided_by: String(u.id), decided_at: new Date().toISOString() });
        const na = { ...a, status: act };
        await deliver(na); await refreshCards(na);
        if (act === "left") await send("main", chat, "🚪 Отпущен. Бойцов теперь: <b>" + await membersCount() + "</b>");
        return;
      }
      await patch("rdx_apps?id=eq." + a.id, { status: act, decided_by: String(u.id), decided_at: new Date().toISOString() });
      const na = { ...a, status: act };
      const okd = await deliver(na);
      await refreshCards(na);
      if (!okd) await send("main", chat, "⏳ #" + a.id + ": человек ещё не открыл бота — сообщу ему, когда откроет.");
    }
    return;
  }
  const m = up.message;
  if (!m?.from || m.from.is_bot || m.chat?.type !== "private") return;
  if (m.contact) {   // номер, которым поделились через кнопку: только свой
    if (Number(m.contact.user_id) !== Number(m.from.id)) return send("main", m.chat.id, "Это не твой номер — нажми кнопку «📱 Поделиться номером».", { reply_markup: { remove_keyboard: true } });
    const ph = "+" + String(m.contact.phone_number || "").replace(/\D/g, "");
    if (!(await db("rdx_accounts?select=user_id&user_id=eq." + m.from.id))?.[0]) return send("main", m.chat.id, "Сначала зарегистрируйся на сайте RDX (Sign_In), потом привяжи номер.", { reply_markup: { remove_keyboard: true } });
    await patch("rdx_accounts?user_id=eq." + m.from.id, { phone: ph, phone_verified: true });
    await hist(Number(m.from.id), "security", "Телефон привязан: " + maskPhone(ph));
    return send("main", m.chat.id, "✅ Телефон " + maskPhone(ph) + " привязан к аккаунту RDX. Его видно в настройках аккаунта на сайте.", { reply_markup: { remove_keyboard: true } });
  }
  const u = m.from, chat = m.chat.id, text = String(m.text ?? m.caption ?? "").trim();
  if (!isOwner(u) && await isBanned(u.id, u.username)) return;   // забанен в клане — боты не отвечают
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
    if (arg === "phone") return send("main", chat, "📱 Нажми кнопку ниже, чтобы привязать свой номер телефона к аккаунту RDX. Telegram сам подтвердит, что номер твой.", { reply_markup: { keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
    if (arg === "site") return send("main", chat, "✅ Бот подключён к сайту.\nВернись на сайт RDX и нажми «Получить код» — код для входа придёт сюда.");
    return startFlow(u, chat, ["apply", "appeal", "help", "ai"].includes(arg) ? arg : "menu");
  }
  if (text === "/menu" || text === "/cancel") return startFlow(u, chat, "menu");
  if (text === "/tokens") return send("main", chat, await tokensText(u.id));
  if (/^\/promo(@\S+)?\b/i.test(text) || PROMO_RE.test(text)) {
    const c = text.match(PROMO_RE);
    return send("main", chat, c ? await redeemRdxPromo(u.id, c[0]) : "Напиши так: /promo RDX-XXXX-XXXX");
  }
  if (await tryModKey("main", m)) return;
  if ((text.startsWith("/") && (await isMod(u) || await isMarshal(u)) || isOwner(u) && modIntent(text)) && await adminCmd("main", u, chat, text)) return;
  const st = await getState("main", u.id);
  if (!text) return;
  if (st?.flow === "clfind" && await isMod(u)) { await setState("main", u.id, null); return clanFind(chat, text); }
  if (st?.flow === "clweapon") {
    await setState("main", u.id, null);
    const r = await setClass(u, Number(st.data?.id), "weapon", text);
    return send("main", chat, r.text, kb([[["🎖 Карточка", "cl:m:" + Number(st.data?.id)], ["👥 Состав", "cl:list"]]]));
  }
  if (!st || st.flow === "ai") {
    const talk = (await db("rdx_apps?select=id,talk_by,data&talk_open=eq.true&user_id=eq." + u.id + "&order=created_at.desc&limit=1"))?.[0];
    if (talk?.talk_by) {
      await ins("rdx_talks", [{ app_id: talk.id, dir: "in", by_name: u.first_name || "", text: text.slice(0, 2000) }], "return=minimal");
      await send("main", Number(talk.talk_by), "👤 <b>" + esc(talk.data?.nick || u.first_name || "Заявитель") + "</b> (#" + talk.id + "):\n" + esc(text), kb([[["📜 Переписка", "dec:" + talk.id + ":log"], ["⏹ Завершить", "dec:" + talk.id + ":endtalk"]]]));
      return;
    }
  }
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
  if (!isOwner(u) && await isBanned(u.id, u.username)) return;   // забанен в клане — RDX_AI не отвечает
  const group = m.chat.type !== "private";
  const me = await botName("ai");
  if (text.startsWith("/start")) return send("ai", chat, "🤖 <b>RDX_AI</b> — помощник RDX Squad.\nПиши вопрос. Токены: /tokens\nЗаявка, обжалование бана и связь с командирами — в боте RDX" + (await botName("main") ? " @" + BOTNAMES.main : "") + ".");
  if (text.startsWith("/tokens")) return send("ai", chat, await tokensText(u.id), group ? { reply_parameters: { message_id: m.message_id } } : {});
  if (/^\/promo(@\S+)?\b/i.test(text) || (!group && PROMO_RE.test(text))) {
    const c = text.match(PROMO_RE);
    if (group && c) await tg("ai", "deleteMessage", { chat_id: chat, message_id: m.message_id });
    return send("ai", chat, c ? await redeemRdxPromo(u.id, c[0]) : "Напиши так: /promo RDX-XXXX-XXXX");
  }
  if (await tryModKey("ai", m)) return;
  if ((text.startsWith("/") && (await isMod(u) || await isMarshal(u)) || isOwner(u) && modIntent(text)) && await adminCmd("ai", u, chat, text)) return;
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
  if (r?.[0]?.user_id) return Number(r[0].user_id);
  const s2 = await db("seals_tgai_members?select=user_id&username=ilike." + enc(a) + "&order=seen_at.desc&limit=1");
  return s2?.[0]?.user_id ? Number(s2[0].user_id) : null;
}
function modIntent(text: string) {
  const t = text.toLowerCase().replace(/ё/g, "е");
  const nick = (text.match(/@([A-Za-z0-9_]{3,32})/) || [])[1];
  if (!nick || !/модер/.test(t)) return null;
  if (/(сними|убери|забери|сня|удали|лиши)/.test(t)) return "/unmod @" + nick;
  if (/(дай|выдай|сделай|назнач|поставь|добавь|верни)/.test(t)) return "/makemod @" + nick;
  return null;
}
async function adminCmd(bot: Bot, u: any, chat: number, text: string) {
  if (!text.startsWith("/") && isOwner(u)) { const c = modIntent(text); if (!c) return false; text = c; }
  const [cmd0, ...args] = text.split(/\s+/);
  const cmd = cmd0.split("@")[0].toLowerCase();
  const say = (s: string) => send(bot, chat, s);
  const owner = isOwner(u);
  const modU = owner || (await modIds()).includes(Number(u.id)), marshal = !owner && await isMarshal(u);
  if (!modU) {   // маршал без прав модератора: только раздача токенов и промокоды Premium / Premium Plus
    if (!marshal) return false;
    if (cmd === "/mod" || cmd === "/help" || cmd === "/admin") {
      const [tk, pm] = await Promise.all([modUsed(u.id, "tokens", 86400e3), modUsed(u.id, "mpromo", 7 * 86400e3)]);
      await say("<b>🎖 Команды маршала RDX</b>\n/give @ник 150 — дать вопросов RDX_AI (всего " + MARSHAL_TOKENS + " в сутки, осталось " + Math.max(0, MARSHAL_TOKENS - tk) + ")\n"
        + "/promo_new premium 7 — промокод RDX_AI Premium на 1–" + MARSHAL_PROMO_DAYS + " дней (plus — Premium Plus), можно сразу несколько: /promo_new plus 7 3 (осталось " + Math.max(0, MARSHAL_PROMO_WEEK - pm) + " из " + MARSHAL_PROMO_WEEK + " на неделю)\n"
        + "В SealsAI: /give @ник 150 и /premiumpromo premium 7");
      return true;
    }
    if (!["/give", "/promo_new"].includes(cmd)) return false;
  }
  if (cmd === "/logout" && !owner) {
    await del("rdx_mods?user_id=eq." + u.id); MODS = null; await modMenu(u.id, false);
    await say("Ты больше не модератор RDX."); return true;
  }
  if (cmd === "/mod" || (!owner && (cmd === "/admin" || cmd === "/help"))) {
    const [tk, vp, pm] = await Promise.all([modUsed(u.id, "tokens", 86400e3), modUsed(u.id, "vip", 7 * 86400e3), modUsed(u.id, "promo", 7 * 86400e3)]);
    await say("<b>🛡 Команды модератора RDX</b>\n"
      + "Заявки приходят сюда с кнопками «Принять», «Отклонить», «Допрос», «Закрыть заявку».\n\n"
      + "/give @ник 150 — дать вопросов RDX_AI (всего " + MOD_TOKENS_DAY + " в сутки, осталось " + Math.max(0, MOD_TOKENS_DAY - tk) + ")\n"
      + "/vip @ник 3 — выдать VIP на 1–" + MOD_MAX_DAYS + " дня (осталось " + Math.max(0, MOD_VIP_WEEK - vp) + " из " + MOD_VIP_WEEK + " на неделю)\n"
      + "/vippromo 3 — промокод RDX на VIP на 1–" + MOD_MAX_DAYS + " дня (осталось " + Math.max(0, MOD_PROMO_WEEK - pm) + " из " + MOD_PROMO_WEEK + " на неделю)\n"
      + "/apps — новые заявки\n/logout — выйти из модераторов"); return true;
  }
  if (cmd === "/give" || cmd === "/vip" || cmd === "/vippromo") {
    const lim = !owner;   // у создателя лимитов нет
    if (cmd === "/vippromo") {
      const days = Number(args[0]);
      if (!(days >= 1 && days <= MOD_MAX_DAYS) && lim) { await say("Срок — от 1 до " + MOD_MAX_DAYS + " дней. Пример: /vippromo 3"); return true; }
      if (lim && await modUsed(u.id, "promo", 7 * 86400e3) >= MOD_PROMO_WEEK) { await say("На этой неделе лимит промокодов исчерпан (" + MOD_PROMO_WEEK + ")."); return true; }
      const [code] = await makePromos("vip", days || 1, 1, u.id);
      await modLog(u.id, "promo", 1, code);
      await say("🎟 Промокод RDX_AI <b>VIP</b> на " + (days || 1) + " дн.:\n<code>" + code + "</code>\nАктивировать: /promo " + code); return true;
    }
    const uid = args[0] ? await findUser(args[0]) : null;
    if (!uid) { await say(cmd === "/give" ? "Пример: /give @ник 150 (человек должен хоть раз открыть бота RDX)" : "Пример: /vip @ник 3 (человек должен хоть раз открыть бота RDX)"); return true; }
    if (cmd === "/give") {
      const n = Math.floor(Number(args[1]) || 0);
      if (n < 1) { await say("Сколько? Пример: /give @ник 150"); return true; }
      const dayLim = (await isMarshal(u)) ? MARSHAL_TOKENS : MOD_TOKENS_DAY;
      const left = dayLim - await modUsed(u.id, "tokens", 86400e3);
      if (lim && n > left) { await say("Можно раздать ещё " + Math.max(0, left) + " из " + dayLim + " на сегодня."); return true; }
      await ins("rdx_bonus", [{ user_id: uid, amount: n, until: new Date(Date.now() + 7 * 86400e3).toISOString() }], "return=minimal");
      await modLog(u.id, "tokens", n, String(uid));
      await say("✅ " + esc(args[0]) + ": +" + n + " вопросов RDX_AI на 7 дней." + (lim ? " Осталось на сегодня: " + (left - n) : ""));
      await send("main", uid, "🎁 Тебе добавили " + n + " вопросов RDX_AI. Проверить: /tokens"); return true;
    }
    // /vip
    const days = Number(args[1]);
    if (!(days >= 1 && days <= MOD_MAX_DAYS) && lim) { await say("Срок — от 1 до " + MOD_MAX_DAYS + " дней. Пример: /vip @ник 3"); return true; }
    if (lim && await modUsed(u.id, "vip", 7 * 86400e3) >= MOD_VIP_WEEK) { await say("На этой неделе лимит выдачи VIP исчерпан (" + MOD_VIP_WEEK + ")."); return true; }
    const cur = await tierOf(uid, false);
    if (cur.tier !== "base" && cur.tier !== "vip") { await say("У " + esc(args[0]) + " уже уровень выше VIP (" + TIERS[cur.tier].name + ")."); return true; }
    const from = cur.tier === "vip" && cur.until ? Math.max(Date.now(), Date.parse(cur.until)) : Date.now();
    await upsert("rdx_premium", [{ user_id: uid, tier: "vip", until: new Date(from + (days || 1) * 86400e3).toISOString(), updated_at: new Date().toISOString() }], "user_id");
    await modLog(u.id, "vip", 1, String(uid));
    await say("✅ " + esc(args[0]) + ": RDX_AI VIP на " + (days || 1) + " дн.");
    await send("main", uid, "⭐ Тебе выдали RDX_AI VIP на " + (days || 1) + " дн. Проверить: /tokens"); return true;
  }
  if ((owner || await isMarshal(u)) && cmd === "/promo_new") {   // создатель: любые уровни; маршал: premium | plus
    const tier = String(args[0] || "").toLowerCase(), days = Number(args[1]), cnt = Math.max(1, Math.min(50, Number(args[2]) || 1));
    if (!owner) {
      if (!["premium", "plus"].includes(tier) || !(days >= 1 && days <= MARSHAL_PROMO_DAYS)) { await say("Маршал делает промокоды Premium и Premium Plus на 1–" + MARSHAL_PROMO_DAYS + " дней. Пример: /promo_new plus 7"); return true; }
      const usedW = await modUsed(u.id, "mpromo", 7 * 86400e3);
      if (usedW + cnt > MARSHAL_PROMO_WEEK) { await say("На этой неделе можно сделать ещё " + Math.max(0, MARSHAL_PROMO_WEEK - usedW) + " из " + MARSHAL_PROMO_WEEK + " промокодов."); return true; }
    }
    if (!TIERS[tier] || tier === "base" || tier === "mod" || tier === "clan" || tier.startsWith("r") || !(days > 0)) { await say("Пример: /promo_new plus 30 5 — 5 кодов Premium Plus на 30 дней"); return true; }
    const codes = await makePromos(tier, days, cnt, u.id);
    if (!owner) await modLog(u.id, "mpromo", cnt, codes.join(","));
    await say("🎟 Промокоды RDX_AI <b>" + TIERS[tier].name + "</b> на " + days + " дн.:\n" + codes.map((c) => "<code>" + c + "</code>").join("\n")); return true;
  }
  if (cmd === "/fire" && args[0]) {   // уволить бойца
    const id = await findUser(args[0]);
    const nick = args[0].replace(/^@/, "");
    const r: any[] = await db("rdx_members?select=id,user_id,nick&active=eq.true&" + (id ? "user_id=eq." + id : "or=(username.ilike." + enc(nick) + ",nick.ilike." + enc(nick) + ")")) || [];
    if (!r.length) { await say("Не нашёл такого бойца в составе."); return true; }
    await patch("rdx_members?id=eq." + r[0].id, { active: false, left_at: new Date().toISOString() });
    if (r[0].user_id) await send("main", Number(r[0].user_id), "🚪 Тебя исключили из RDX Squad.");
    await say("🚪 " + esc(r[0].nick || args[0]) + " исключён. Бойцов теперь: <b>" + await membersCount() + "</b>"); return true;
  }
  if (cmd === "/roster") {
    const r: any[] = await db("rdx_members?select=nick,username,joined_at&active=eq.true&order=joined_at") || [];
    await say("<b>Состав RDX</b> — в строю: " + await membersCount() + (r.length ? "\n\n" + r.map((x, i) => (i + 1) + ". " + esc(x.nick || "") + (x.username ? " @" + esc(x.username) : "")).join("\n") : "")); return true;
  }
  if ((owner || await isRankAdmin(u)) && cmd === "/rank" && args[0]) {   // /rank @ник 5
    const r = await clanApi(u, "rank", args[0], args[1] !== undefined ? Number(args[1]) : null);
    await say(r.text); return true;
  }
  if (owner && cmd === "/unban" && args[0]) {
    const nick = args[0].replace(/^@/, ""), id = await findUser(args[0]);
    await del("rdx_bans?" + (id ? "or=(user_id.eq." + id + ",username.ilike." + enc(nick) + ")" : "username=ilike." + enc(nick))); BANS = null;
    await say("✅ " + esc(args[0]) + " разбанен. В состав он не возвращается — для этого нужна новая заявка или /addmember."); return true;
  }
  if (owner && cmd === "/bans") {
    const r: any[] = await db("rdx_bans?select=user_id,username,nick,created_at&order=created_at") || [];
    await say(r.length ? "<b>🚫 Забаненные</b>\n" + r.map((x, i) => (i + 1) + ". " + esc(x.nick || "") + (x.username ? " @" + esc(x.username) : "") + (x.user_id ? " · id " + x.user_id : "")).join("\n") + "\n\nРазбанить: /unban @ник" : "Забаненных нет."); return true;
  }
  if (owner && cmd === "/addmember" && args.length) {   // /addmember @ник Имя  ·  /addmember Имя (без Telegram)
    const tgArg = args[0].startsWith("@") ? args[0] : null;
    const nick = (tgArg ? args.slice(1) : args).join(" ").trim() || (tgArg ? tgArg.slice(1) : "");
    const id = tgArg ? await findUser(tgArg) : null;
    const same = (await db("rdx_members?select=id&active=eq.true&user_id=is.null&nick=ilike." + enc(nick)))?.[0];
    const row = { user_id: id, username: tgArg ? tgArg.slice(1) : null, nick, active: true };
    if (same) await patch("rdx_members?id=eq." + same.id, row); else await ins("rdx_members", [row], "return=minimal");
    await say("🎖 " + esc(nick) + (tgArg ? " (" + esc(tgArg) + (id ? "" : ", ещё не писал ботам — привяжется, когда напишет") + ")" : "") + (same ? " — Telegram привязан." : " добавлен в состав.") + " Бойцов: <b>" + await membersCount() + "</b>");
    return true;
  }
  if (owner && cmd === "/mods") {
    const r: any[] = await db("rdx_mods?select=user_id,username,first_name,added_at&order=added_at") || [];
    await say(r.length ? "<b>Модераторы RDX</b>\n" + r.map((x, i) => (i + 1) + ". " + esc(x.first_name || "") + (x.username ? " @" + esc(x.username) : "") + " · id " + x.user_id).join("\n") + "\n\nСнять: /unmod @ник" : "Модераторов пока нет. Ключ модератора вводится в любом из ботов RDX.");
    return true;
  }
  if (owner && cmd === "/makemod" && args[0]) {
    const id = await findUser(args[0]);
    if (!id) { await say("Не знаю " + esc(args[0]) + ": человек должен хоть раз написать боту RDX, RDX_AI или SealsAI."); return true; }
    await upsert("rdx_mods", [{ user_id: id, username: args[0].replace(/^@/, ""), added_at: new Date().toISOString() }], "user_id"); MODS = null;
    await say("🛡 " + esc(args[0]) + " теперь модератор RDX и SealsAI.");
    await send("main", id, "🛡 <b>Создатель назначил тебя модератором RDX и SealsAI.</b>\nТвой уровень — «Модератор». Команды: /mod"); return true;
  }
  if (owner && cmd === "/unmod" && args[0]) {
    const id = await findUser(args[0]) ?? (await db("rdx_mods?select=user_id&username=ilike." + enc(args[0].replace(/^@/, ""))))?.[0]?.user_id;
    if (!id) { await say("Не нашёл такого модератора."); return true; }
    await del("rdx_mods?user_id=eq." + id); MODS = null; await modMenu(Number(id), false);
    await say("✅ " + esc(args[0]) + " больше не модератор."); await send("main", Number(id), "Тебя сняли с модераторов RDX."); return true;
  }
  if (cmd === "/apps") {
    const r: any[] = await db("rdx_apps?select=*&status=eq.new&order=created_at.desc&limit=10") || [];
    if (!r.length) { await say("Новых заявок нет."); return true; }
    for (const a of r.reverse()) await send("main", chat, appText(a), appButtons(a));
    return true;
  }
  if (!owner) return false;   // дальше — только создатель
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
      if (!TIERS[tier] || tier === "base" || tier === "mod" || tier === "clan") { await say("Уровни: vip, premium, plus, ultra, max (или none). Пример: /grant @nick plus 30"); return true; }
      const days = /^(forever|навсегда)$/i.test(args[2] || "") ? 36500 : Number(args[2]) > 0 ? Number(args[2]) : 30;
      await upsert("rdx_premium", [{ user_id: uid, tier, until: new Date(Date.now() + days * 86400e3).toISOString(), updated_at: new Date().toISOString() }], "user_id");
      await say("✅ " + esc(args[0]) + ": " + TIERS[tier].name + " " + (days >= 36500 ? "навсегда" : "на " + days + " дн.")); return true;
    }
  }
  if (cmd === "/admin" || cmd === "/help") {
    await say("<b>Команды создателя</b>\nКнопка «👥 Состав клана» в меню — список, поиск, бан, кик, увольнение\n/apps — новые заявки\n/roster — состав · /fire @ник — исключить\n/addmember @ник Имя — добавить в состав (или привязать Telegram)\n/bans — забаненные · /unban @ник — разбанить\n/rank @ник 0–14 — звание (или кнопки в «Состав клана», или словами: «повысь @ник до маршала»)\n/mods — модераторы · /unmod @ник — снять\n/promo_new уровень дней [штук] — промокоды RDX_AI\n/makemod @ник — назначить модератора (или просто напиши «дай модера @ник»)\n/give @ник N · /vip @ник дней · /vippromo дней — как у модератора, но без лимитов\n/tokens @ник — вопросы у человека\n/reset @ник — восстановить вопросы\n/add @ник 10 [дней] — добавить вопросы\n/unlim @ник [дней|off] — безлимит\n/grant @ник vip|premium|plus|ultra|max [дней|навсегда] — привилегия\n/grant @ник none — снять");
    return true;
  }
  return false;
}

// ---------- заявка с сайта ----------
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {   // 25 символов из 32 = 125 бит: подобрать невозможно
  const r = crypto.getRandomValues(new Uint8Array(25));
  const c = [...r].map((x) => CODE_ABC[x % 32]).join("");
  return "RDX-" + c.match(/.{5}/g)!.join("-");
}
const sha = async (x: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)))].map((v) => v.toString(16).padStart(2, "0")).join("");
const normCode = (c: unknown) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^RDX/, "");
async function ipHashOf(req: Request) { return (await sha("rdx:" + (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?"))).slice(0, 24); }
function appFields(b: any) {
  return { nick: String(b.nick || "").trim().slice(0, 40), age: String(b.age || "").slice(0, 3), tz: String(b.tz || "").slice(0, 40), platform: String(b.platform || "").slice(0, 30),
    exp: String(b.exp || "").slice(0, 20), weapon: String(b.weapon || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 40), dept: DEPTS.includes(String(b.dept)) ? String(b.dept) : "", why: String(b.why || "").trim().slice(0, 1200) };
}
async function siteFind(req: Request, b: any) {
  const ip = await ipHashOf(req);
  const tries: any[] = await db("rdx_quota?select=id&subject=eq.edit:" + ip + "&at=gt." + enc(new Date(Date.now() - 3600e3).toISOString())) || [];
  if (tries.length >= 30) return { err: { ok: false, error: "rate", status: 429 } };
  await ins("rdx_quota", [{ subject: "edit:" + ip }], "return=minimal");
  const code = normCode(b.code);
  if (code.length !== 25) return { err: { ok: false, error: "code" } };
  const a = (await db("rdx_apps?select=*&kind=eq.apply&edit_hash=eq." + await sha(code)))?.[0];
  return a ? { a } : { err: { ok: false, error: "code" } };
}
async function siteGet(req: Request, b: any) {
  const { a, err } = await siteFind(req, b);
  if (err) return err;
  const d = a.data || {};
  return { ok: true, id: a.id, state: a.status, editable: a.status === "new" || a.status === "reply", data: { nick: d.nick, tg: d.tg, age: d.age, tz: d.tz, platform: d.platform, exp: d.exp, weapon: d.weapon, dept: d.dept, why: d.why } };
}
async function siteEdit(req: Request, b: any) {
  const { a, err } = await siteFind(req, b);
  if (err) return err;
  if (!(a.status === "new" || a.status === "reply")) return { ok: false, error: "locked" };
  const f = appFields(b);
  if (!f.nick || !f.why || !f.dept) return { ok: false, error: "bad" };
  const data = { ...a.data, ...f };
  const now = new Date().toISOString();
  await patch("rdx_apps?id=eq." + a.id, { data, edited_at: now });
  const na = { ...a, data, edited_at: now };
  await refreshCards(na);
  return { ok: true, id: a.id };
}
async function siteApply(req: Request, b: any) {
  if (b.website) return { ok: true };   // ловушка для ботов
  const nick = String(b.nick || "").trim().slice(0, 40), tgName = String(b.tg || "").trim().replace(/^@/, "").slice(0, 32), why = String(b.why || "").trim().slice(0, 1200);
  if (!nick || !/^[A-Za-z0-9_]{5,32}$/.test(tgName) || !why || !DEPTS.includes(String(b.dept))) return { ok: false, error: "bad" };
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
  void ip; const ipHash = await ipHashOf(req);
  const recent: any[] = await db("rdx_apps?select=id&ip_hash=eq." + ipHash + "&created_at=gt." + enc(new Date(Date.now() - 3600e3).toISOString())) || [];
  if (recent.length >= 3) return { ok: false, error: "rate", status: 429 };
  const known = (await db("rdx_users?select=user_id&started=eq.true&username=ilike." + enc(tgName)))?.[0]?.user_id || null;
  if (await isBanned(Number(known) || 0, tgName)) return { ok: false, error: "banned" };
  const code = newCode();
  const a = await newApp({ kind: "apply", source: "site", user_id: known, username: tgName, ip_hash: ipHash, edit_hash: await sha(normCode(code)),
    data: { ...appFields(b), nick, why, tg: tgName, lang: String(b.lang || "").slice(0, 5), from: "сайт · @" + tgName } });
  if (!a) return { ok: false, error: "db" };
  if (known) await send("main", known, "📝 Заявка с сайта #" + a.id + " получена. Решение придёт сюда.");
  return { ok: true, id: a.id, code, bot: await botName("main") };
}

// ---------- письма от «RDX Squad»: SMTP по TLS (порт 465). Секреты: RDX_SMTP_USER, RDX_SMTP_PASS, [RDX_SMTP_HOST], [RDX_SMTP_NAME] ----------
const SMTP_ON = () => !!(Deno.env.get("RDX_SMTP_USER") && Deno.env.get("RDX_SMTP_PASS"));
const b64u = (x: string) => { const b = new TextEncoder().encode(x); let s0 = ""; for (const c of b) s0 += String.fromCharCode(c); return btoa(s0); };
async function smtpSend(to: string, subject: string, html: string, text: string) {
  const host = Deno.env.get("RDX_SMTP_HOST") || "smtp.gmail.com", user = Deno.env.get("RDX_SMTP_USER")!, pass = Deno.env.get("RDX_SMTP_PASS")!, name = Deno.env.get("RDX_SMTP_NAME") || "RDX Squad";
  const conn = await Deno.connectTls({ hostname: host, port: 465 });
  const dec = new TextDecoder(), enc2 = new TextEncoder(); let buf = "";
  const read = async () => {   // ответ сервера (с многострочными 250-…)
    for (;;) {
      const lines = buf.split("\r\n"); for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) { const code = Number(lines[i].slice(0, 3)); buf = lines.slice(i + 1).join("\r\n"); return code; }
      const chunk = new Uint8Array(4096); const n = await conn.read(chunk); if (n === null) throw new Error("smtp closed"); buf += dec.decode(chunk.subarray(0, n));
    }
  };
  const cmd = async (c: string, ok: number[]) => { await conn.write(enc2.encode(c + "\r\n")); const r = await read(); if (!ok.includes(r)) throw new Error("smtp " + c.split(" ")[0] + " " + r); };
  try {
    if (await read() !== 220) throw new Error("smtp greet");
    await cmd("EHLO rdx.squad", [250]);
    await cmd("AUTH LOGIN", [334]); await cmd(btoa(user), [334]); await cmd(btoa(pass), [235]);
    await cmd("MAIL FROM:<" + user + ">", [250]); await cmd("RCPT TO:<" + to + ">", [250, 251]); await cmd("DATA", [354]);
    const bd = "rdx" + rnd(8), wrap = (x: string) => b64u(x).replace(/.{1,76}/g, "$&\r\n");
    const msg = ["From: =?UTF-8?B?" + b64u(name) + "?= <" + user + ">", "To: <" + to + ">", "Subject: =?UTF-8?B?" + b64u(subject) + "?=", "Date: " + new Date().toUTCString(), "MIME-Version: 1.0",
      "Message-ID: <" + rnd(12) + "@rdx.squad>", 'Content-Type: multipart/alternative; boundary="' + bd + '"', "", "--" + bd, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(text),
      "--" + bd, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(html), "--" + bd + "--", "."].join("\r\n");
    await cmd(msg, [250]);
    await cmd("QUIT", [221]).catch(() => null);
  } finally { try { conn.close(); } catch { /* */ } }
}
function mailHtml(title: string, code: string, note: string) {
  return '<div style="background:#121316;padding:32px 16px;font-family:Arial,sans-serif;color:#ecebe7"><div style="max-width:460px;margin:0 auto;background:#1b1d21;border:1px solid #2c2f35;border-radius:18px;padding:28px">'
    + '<img src="' + SITE + 'assets/avatar-rdx.png" width="64" height="64" alt="RDX" style="border-radius:16px;display:block;margin-bottom:16px">'
    + '<div style="font:900 22px Arial;letter-spacing:.5px;text-transform:uppercase">' + title + '</div><p style="color:#a7a9ad;line-height:1.5">' + note + '</p>'
    + '<div style="font:700 34px monospace;letter-spacing:8px;color:#ff7a1a;background:#121316;border-radius:12px;padding:14px;text-align:center">' + code + '</div>'
    + '<p style="color:#6f7278;font-size:12px;margin-top:18px">RDX Squad — Revolvers and Explosives · ' + SITE + '<br>Если это были не вы — просто проигнорируйте письмо.</p></div></div>';
}
async function mailCode(to: string, code: string, what: string) {
  await smtpSend(to, "RDX Squad — код " + code, mailHtml("Код подтверждения", code, "Код для " + what + " на сайте RDX. Действует 10 минут, никому его не сообщайте."), "Код для " + what + " на сайте RDX: " + code + "\nДействует 10 минут. Если это были не вы — проигнорируйте письмо.");
}
const maskMail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, "$1•••$2");
const maskPhone = (p0: string) => p0.replace(/^(\+?\d{1,3})\d+(\d{2})$/, "$1 ••• •• $2");
// ---------- аккаунты на сайте: вход по коду из Telegram, сессии по отпечатку устройства, 2FA для создателя ----------
const rnd = (n = 32) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const ipOfReq = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
async function geoOf(ip: string) {
  try {
    const r: any = await fetch("https://ipwho.is/" + encodeURIComponent(ip) + "?fields=success,country,city,flag", { signal: AbortSignal.timeout(3000) }).then((x) => x.json());
    return r?.success ? ((r.flag?.emoji || "") + " " + r.country + (r.city ? ", " + r.city : "")).trim() : "неизвестно";
  } catch { return "неизвестно"; }
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32enc = (b: Uint8Array) => { let bits = 0, v = 0, o = ""; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += B32[(v << (5 - bits)) & 31]; return o; };
const b32dec = (s0: string) => { const s1 = s0.replace(/=+$/, "").toUpperCase(); let bits = 0, v = 0; const o: number[] = []; for (const ch of s1) { const i = B32.indexOf(ch); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(o); };
async function totpAt(secret: string, step: number) {
  const key = await crypto.subtle.importKey("raw", b32dec(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8); let c = step; for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
async function totpOk(secret: string, code: string) {
  const c = String(code || "").replace(/\D/g, ""); if (c.length !== 6) return false;
  const st = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) if (await totpAt(secret, st + d) === c) return true;
  return false;
}
const accUser = async (nick: string) => (await db("rdx_users?select=user_id,username,first_name,started&username=ilike." + enc(String(nick || "").trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//, ""))))?.[0];
async function newSession(uid: number, req: Request, b: any, stage: string) {
  const token = rnd(32), ip = ipOfReq(req), remember = !!b.remember;
  await ins("rdx_sessions", [{ user_id: uid, token_hash: await sha("sess:" + token), fp_hash: await sha("fp:" + String(b.fp || "")), ip, country: stage === "ok" ? await geoOf(ip) : null, dev: String(b.dev || "").slice(0, 120), stage, remember,
    expires_at: new Date(Date.now() + (stage !== "ok" ? 20 * 60e3 : remember ? 30 * 86400e3 : 12 * 3600e3)).toISOString() }], "return=minimal");
  return token;
}
async function sessionOf(b: any, stage = "ok") {
  const t = String(b.token || b.pending || ""); if (!t) return null;
  const s0 = (await db("rdx_sessions?select=*&token_hash=eq." + (await sha("sess:" + t)) + "&revoked=eq.false"))?.[0];
  if (!s0 || s0.stage !== stage && !(stage === "pending" && s0.stage !== "ok")) return null;
  if (Date.parse(s0.expires_at) < Date.now()) return null;
  if (s0.fp_hash !== await sha("fp:" + String(b.fp || ""))) return null;   // другое устройство — сессия не подходит
  return s0;
}
async function loginDone(s0: any, req: Request, b: any) {   // сессия активна: уведомление о входе в Telegram
  const ip = ipOfReq(req), country = await geoOf(ip), remember = !!b.remember || !!s0.remember;
  await patch("rdx_sessions?id=eq." + s0.id, { stage: "ok", country, ip, remember, expires_at: new Date(Date.now() + (remember ? 30 * 86400e3 : 12 * 3600e3)).toISOString() });
  await hist(Number(s0.user_id), "login", "Вход на сайт: " + country + " · IP " + ip + (s0.dev ? " · " + s0.dev : ""));
  const accM = (await db("rdx_accounts?select=email,email_verified&user_id=eq." + s0.user_id))?.[0];
  if (SMTP_ON() && accM?.email_verified && accM.email) smtpSend(accM.email, "RDX Squad — новый вход в аккаунт", mailHtml("Новый вход", "🔐", "Вход на сайт RDX: " + esc(country) + " · IP " + esc(ip) + (s0.dev ? " · " + esc(s0.dev) : "") + ". Если это не вы — сбросьте входы в боте RDX или на странице аккаунта."), "Новый вход на сайт RDX: " + country + ", IP " + ip).catch((e) => console.error("smtp", String(e)));
  await send("main", Number(s0.user_id), "🔐 <b>Новый вход в аккаунт RDX на сайте</b>\nСтрана: " + esc(country) + "\nIP: <code>" + esc(ip) + "</code>" + (s0.dev ? "\nУстройство: " + esc(s0.dev) : "") + "\n\nЕсли это не ты — нажми кнопку: все входы будут сброшены.", kb([[["🚫 Выкинуть всех из аккаунта", "acc:kill"]]]));
}
const accJ = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
async function accApi(req: Request, b: any): Promise<Response> {
  const t = String(b.type);
  if (t === "acc_code") {   // шаг 1: ник → код в Telegram
    const mode = b.mode === "signup" ? "signup" : "login";
    const u0 = await accUser(b.nick);
    if (!u0?.started) return accJ({ ok: false, error: "need_bot", bot: await botName("main") });
    const uid = Number(u0.user_id);
    if (!ADMINS.includes(uid) && await isBanned(uid, u0.username)) return accJ({ ok: false, error: "banned" });
    const acc = (await db("rdx_accounts?select=user_id&user_id=eq." + uid))?.[0];
    if (mode === "signup" && acc) return accJ({ ok: false, error: "exists" });
    if (mode === "login" && !acc) return accJ({ ok: false, error: "no_account" });
    const ipH = await ipHashOf(req), hr = enc(new Date(Date.now() - 3600e3).toISOString());
    const [byU, byIp] = await Promise.all([db("rdx_login_codes?select=id&user_id=eq." + uid + "&created_at=gt." + hr), db("rdx_login_codes?select=id&ip_hash=eq." + ipH + "&created_at=gt." + hr)]);
    if ((byU || []).length >= 5 || (byIp || []).length >= 12) return accJ({ ok: false, error: "rate" });
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    await ins("rdx_login_codes", [{ user_id: uid, ip_hash: ipH, code_hash: await sha("code:" + uid + ":" + code), mode, expires_at: new Date(Date.now() + 10 * 60e3).toISOString() }], "return=minimal");
    const r: any = await send("main", uid, "🔐 Код для " + (mode === "signup" ? "регистрации" : "входа") + " на сайте RDX: <code>" + code + "</code>\nДействует 10 минут. Никому его не сообщай — даже командирам.\nЕсли это не ты — просто проигнорируй.");
    if (!r?.ok) return accJ({ ok: false, error: "need_bot", bot: await botName("main") });
    return accJ({ ok: true });
  }
  if (t === "acc_verify") {   // шаг 2: код из Telegram
    const u0 = await accUser(b.nick); if (!u0) return accJ({ ok: false, error: "bad" });
    const uid = Number(u0.user_id);
    const c0 = (await db("rdx_login_codes?select=*&user_id=eq." + uid + "&used=eq.false&order=created_at.desc&limit=1"))?.[0];
    if (!c0 || Date.parse(c0.expires_at) < Date.now() || c0.tries >= 5) return accJ({ ok: false, error: "expired" });
    if (c0.code_hash !== await sha("code:" + uid + ":" + String(b.code || "").replace(/\D/g, ""))) { await patch("rdx_login_codes?id=eq." + c0.id, { tries: c0.tries + 1 }); return accJ({ ok: false, error: "code", left: 4 - c0.tries }); }
    await patch("rdx_login_codes?id=eq." + c0.id, { used: true });
    if (c0.mode === "signup") await upsert("rdx_accounts", [{ user_id: uid, username: u0.username }], "user_id");
    const accU = (await db("rdx_accounts?select=*&user_id=eq." + uid))?.[0] || {};
    if (!ADMINS.includes(uid) && accU.totp_enabled) {   // боец включил Google Authenticator
      const pending = await newSession(uid, req, b, "totp");
      return accJ({ ok: true, step: "totp", pending });
    }
    if (ADMINS.includes(uid)) {   // создатель: почта + Google Authenticator
      const acc = accU;
      const stage = !acc.email_verified ? "email" : !acc.totp_enabled ? "totp_setup" : "totp";
      const pending = await newSession(uid, req, b, stage);
      return accJ({ ok: true, step: stage, pending, ...(stage === "totp_setup" ? await totpSetup(uid) : {}) });
    }
    const token = await newSession(uid, req, b, "pending");
    const s0 = await sessionOf({ token, fp: b.fp }, "pending");
    await loginDone(s0, req, b);
    return accJ({ ok: true, step: "done", token });
  }
  if (t === "acc_email") {   // создатель: почта → письмо со ссылкой
    const s0 = await sessionOf(b, "pending"); if (!s0 || s0.stage !== "email") return accJ({ ok: false, error: "session" });
    const email = String(b.email || "").trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/.test(email)) return accJ({ ok: false, error: "email" });
    await patch("rdx_accounts?user_id=eq." + s0.user_id, { pending_email: email });
    if (SMTP_ON()) {   // письмо от «RDX Squad» с кодом
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
      await ins("rdx_login_codes", [{ user_id: s0.user_id, ip_hash: await ipHashOf(req), code_hash: await sha("mail:" + s0.user_id + ":" + email + ":" + code), mode: "mail", expires_at: new Date(Date.now() + 10 * 60e3).toISOString() }], "return=minimal");
      try { await mailCode(email, code, "подтверждения почты"); } catch (e) { console.error("smtp", String(e)); return accJ({ ok: false, error: "mail" }); }
      return accJ({ ok: true, step: "email_code" });
    }
    const r = await fetch(SB + "/auth/v1/otp?redirect_to=" + encodeURIComponent(SITE), { method: "POST", headers: { apikey: SK, "Content-Type": "application/json" }, body: JSON.stringify({ email, create_user: true }) });
    if (!r.ok) { console.error("email otp", r.status, (await r.text()).slice(0, 200)); return accJ({ ok: false, error: r.status === 429 ? "rate" : "mail" }); }
    return accJ({ ok: true });
  }
  if (t === "acc_email_code") {   // создатель ввёл код из письма RDX
    const s0 = await sessionOf(b, "pending"); if (!s0 || s0.stage !== "email") return accJ({ ok: false, error: "session" });
    const acc = (await db("rdx_accounts?select=*&user_id=eq." + s0.user_id))?.[0];
    if (!(await mailCodeOk(Number(s0.user_id), acc?.pending_email || "", b.code))) return accJ({ ok: false, error: "code" });
    await patch("rdx_accounts?user_id=eq." + s0.user_id, { email: acc.pending_email, email_verified: true });
    await hist(Number(s0.user_id), "security", "Почта подтверждена: " + maskMail(acc.pending_email));
    await patch("rdx_sessions?id=eq." + s0.id, { stage: acc.totp_enabled ? "totp" : "totp_setup" });
    return accJ({ ok: true, step: acc.totp_enabled ? "totp" : "totp_setup", ...(acc.totp_enabled ? {} : await totpSetup(Number(s0.user_id))) });
  }
  if (t === "acc_email_link") {   // создатель открыл ссылку из письма
    const s0 = await sessionOf(b, "pending"); if (!s0 || s0.stage !== "email") return accJ({ ok: false, error: "session" });
    const me: any = await fetch(SB + "/auth/v1/user", { headers: { apikey: SK, Authorization: "Bearer " + String(b.access_token || "") } }).then((x) => x.ok ? x.json() : null).catch(() => null);
    const acc = (await db("rdx_accounts?select=*&user_id=eq." + s0.user_id))?.[0];
    if (!me?.email) console.error("email link: no user", String(b.access_token || "").length);
    if (!me?.email || !acc?.pending_email || me.email.toLowerCase() !== acc.pending_email) return accJ({ ok: false, error: "email_mismatch" });
    await patch("rdx_accounts?user_id=eq." + s0.user_id, { email: acc.pending_email, email_verified: true });
    await hist(Number(s0.user_id), "security", "Почта подтверждена: " + acc.pending_email);
    await patch("rdx_sessions?id=eq." + s0.id, { stage: acc.totp_enabled ? "totp" : "totp_setup" });
    return accJ({ ok: true, step: acc.totp_enabled ? "totp" : "totp_setup", ...(acc.totp_enabled ? {} : await totpSetup(Number(s0.user_id))) });
  }
  if (t === "acc_totp") {   // код из Google Authenticator
    const s0 = await sessionOf(b, "pending"); if (!s0 || !["totp", "totp_setup"].includes(s0.stage)) return accJ({ ok: false, error: "session" });
    const acc = (await db("rdx_accounts?select=*&user_id=eq." + s0.user_id))?.[0];
    if (!acc?.totp_secret || !(await totpOk(acc.totp_secret, b.code))) return accJ({ ok: false, error: "code" });
    if (s0.stage === "totp_setup") { await patch("rdx_accounts?user_id=eq." + s0.user_id, { totp_enabled: true }); await hist(Number(s0.user_id), "security", "Google Authenticator подключён"); }
    await loginDone(s0, req, b);
    return accJ({ ok: true, step: "done", token: String(b.pending) });
  }
  // дальше — только с активной сессией
  const s0 = await sessionOf(b);
  if (!s0) return accJ({ ok: false, error: "session" });
  const uid = Number(s0.user_id), owner = ADMINS.includes(uid);
  if (!owner && await isBanned(uid, null)) return accJ({ ok: false, error: "banned" });
  patch("rdx_sessions?id=eq." + s0.id, { last_seen: new Date().toISOString(), ip: ipOfReq(req) }).catch(() => null);
  if (t === "acc_me") {
    const [u0, m, hs, ss, wn] = await Promise.all([
      db("rdx_users?select=username,first_name&user_id=eq." + uid).then((r: any) => r?.[0] || {}),
      db("rdx_members?select=*&active=eq.true&user_id=eq." + uid).then((r: any) => r?.[0] || null),
      db("rdx_history?select=kind,text,created_at&user_id=eq." + uid + "&order=created_at.desc&limit=40"),
      db("rdx_sessions?select=id,ip,country,dev,created_at,last_seen,remember&user_id=eq." + uid + "&revoked=eq.false&stage=eq.ok&expires_at=gt." + enc(new Date().toISOString()) + "&order=last_seen.desc"),
      warnCount(uid),
    ]);
    const rk = m ? Number(m.rank) || 0 : null;
    return accJ({ ok: true, me: {
      username: u0.username, name: u0.first_name, owner, staff: await isMod({ id: uid }),
      member: m ? { nick: m.nick, rank: rk, rankName: owner ? "Создатель" : RANKS[rk!], next: owner || rk! >= TOP_RANK ? null : RANKS[rk! + 1], top: TOP_RANK, chance: owner ? 100 : Number(m.promo_chance) || 0,
        dept: deptText(rk!, m.dept, owner), cls: classOf(rk!, m.dept, owner) + (m.weapon ? ", " + m.weapon : ""), type: m.weapon ? typeOf(rk!, m.weapon, owner) : "", weapon: weaponText(rk!, m.weapon, owner), joined: m.joined_at } : null,
      warns: wn, security: await (async () => { const a = (await db("rdx_accounts?select=email,email_verified,phone,phone_verified,totp_enabled&user_id=eq." + uid))?.[0] || {};
        return { email: a.email_verified && a.email ? maskMail(a.email) : null, phone: a.phone_verified && a.phone ? maskPhone(a.phone) : null, totp: !!a.totp_enabled, mail: SMTP_ON(), bot: await botName("main") }; })(),
      history: hs || [], sessions: (ss || []).map((x: any) => ({ ...x, current: x.id === s0.id })),
    } });
  }
  if (t === "acc_sec_mail") {   // добавить почту: код в письме от RDX
    if (!SMTP_ON()) return accJ({ ok: false, error: "nomail" });
    const email = String(b.email || "").trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/.test(email)) return accJ({ ok: false, error: "email" });
    const hr = enc(new Date(Date.now() - 3600e3).toISOString());
    if (((await db("rdx_login_codes?select=id&mode=eq.mail&user_id=eq." + uid + "&created_at=gt." + hr)) || []).length >= 4) return accJ({ ok: false, error: "rate" });
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    await patch("rdx_accounts?user_id=eq." + uid, { pending_email: email });
    await ins("rdx_login_codes", [{ user_id: uid, ip_hash: await ipHashOf(req), code_hash: await sha("mail:" + uid + ":" + email + ":" + code), mode: "mail", expires_at: new Date(Date.now() + 10 * 60e3).toISOString() }], "return=minimal");
    try { await mailCode(email, code, "привязки почты"); } catch (e) { console.error("smtp", String(e)); return accJ({ ok: false, error: "mail" }); }
    return accJ({ ok: true });
  }
  if (t === "acc_sec_mail_ok") {
    const acc = (await db("rdx_accounts?select=pending_email&user_id=eq." + uid))?.[0];
    if (!acc?.pending_email || !(await mailCodeOk(uid, acc.pending_email, b.code))) return accJ({ ok: false, error: "code" });
    await patch("rdx_accounts?user_id=eq." + uid, { email: acc.pending_email, email_verified: true });
    await hist(uid, "security", "Почта привязана: " + maskMail(acc.pending_email));
    return accJ({ ok: true });
  }
  if (t === "acc_sec_mail_del") {
    if (owner) return accJ({ ok: false, error: "owner_mail" });
    await patch("rdx_accounts?user_id=eq." + uid, { email: null, email_verified: false, pending_email: null });
    await hist(uid, "security", "Почта отвязана"); return accJ({ ok: true });
  }
  if (t === "acc_sec_2fa") {   // Google Authenticator: setup → on (код) / off (код)
    const acc = (await db("rdx_accounts?select=*&user_id=eq." + uid))?.[0] || {};
    if (b.op === "setup") { if (acc.totp_enabled) return accJ({ ok: false, error: "already" }); if (!acc.totp_secret || !acc.totp_enabled) await patch("rdx_accounts?user_id=eq." + uid, { totp_secret: null }); return accJ({ ok: true, ...(await totpSetup(uid)) }); }
    if (!acc.totp_secret || !(await totpOk(acc.totp_secret, b.code))) return accJ({ ok: false, error: "code" });
    if (b.op === "on") { await patch("rdx_accounts?user_id=eq." + uid, { totp_enabled: true }); await hist(uid, "security", "Google Authenticator включён"); return accJ({ ok: true }); }
    if (b.op === "off") { if (owner) return accJ({ ok: false, error: "owner_2fa" }); await patch("rdx_accounts?user_id=eq." + uid, { totp_enabled: false, totp_secret: null }); await hist(uid, "security", "Google Authenticator выключен"); return accJ({ ok: true }); }
    return accJ({ ok: false, error: "type" });
  }
  if (t === "acc_logout") { await patch("rdx_sessions?id=eq." + s0.id, { revoked: true }); return accJ({ ok: true }); }
  if (t === "acc_kill") {   // выкинуть один вход или всех, кроме себя
    if (b.id === "all") await patch("rdx_sessions?user_id=eq." + uid + "&id=neq." + s0.id + "&revoked=eq.false", { revoked: true });
    else await patch("rdx_sessions?user_id=eq." + uid + "&id=eq." + Number(b.id), { revoked: true });
    await hist(uid, "security", b.id === "all" ? "Все другие входы сброшены с сайта" : "Вход сброшен с сайта");
    return accJ({ ok: true });
  }
  if (t === "acc_admin" || t === "acc_admin_do") {   // админ-панель — только аккаунт создателя
    if (!owner) return accJ({ ok: false, error: "forbidden" }, 403);
    if (t === "acc_admin_do") {
      const actor = { id: uid, username: OWNER_NICK };
      const id = Number(b.member), act = String(b.act);
      const r = act === "rank" ? await setRank(actor, id, Number(b.value)) : act === "chance" ? await setChance(actor, id, Number(b.value)) : act === "warn" ? await warnMember(actor, id, String(b.value || ""))
        : act === "dept" || act === "weapon" ? await setClass(actor, id, act, String(b.value || "")) : CLAN_ACT[act] ? await clanAct(actor, act, id) : { ok: false, text: "?" };
      return accJ({ ok: r.ok, text: r.text.replace(/<[^>]+>/g, "") });
    }
    const all = await clanAll();
    const warns: any[] = await db("rdx_warns?select=user_id&expires_at=gt." + enc(new Date().toISOString())) || [];
    const logins: any[] = await db("rdx_sessions?select=user_id,ip,country,dev,created_at&stage=eq.ok&order=created_at.desc&limit=25") || [];
    const names: any[] = await db("rdx_users?select=user_id,username") || [];
    const nm = (id: number) => names.find((x) => Number(x.user_id) === Number(id))?.username || String(id);
    return accJ({ ok: true, members: all.map((x) => ({ id: x.id, nick: x.nick, username: x.username, rank: Number(x.rank) || 0, chance: Number(x.promo_chance) || 0, dept: x.dept, weapon: x.weapon, owner: ADMINS.includes(Number(x.user_id)),
      warns: warns.filter((w) => Number(w.user_id) === Number(x.user_id)).length })), ranks: RANKS, depts: DEPTS, weapons: WEAPONS,
      logins: logins.map((x) => ({ ...x, who: nm(x.user_id) })) });
  }
  return accJ({ ok: false, error: "type" }, 400);
}
async function mailCodeOk(uid: number, email: string, code: unknown) {
  const c0 = (await db("rdx_login_codes?select=*&user_id=eq." + uid + "&mode=eq.mail&used=eq.false&order=created_at.desc&limit=1"))?.[0];
  if (!c0 || Date.parse(c0.expires_at) < Date.now() || c0.tries >= 5) return false;
  if (c0.code_hash !== await sha("mail:" + uid + ":" + email + ":" + String(code || "").replace(/\D/g, ""))) { await patch("rdx_login_codes?id=eq." + c0.id, { tries: c0.tries + 1 }); return false; }
  await patch("rdx_login_codes?id=eq." + c0.id, { used: true });
  return true;
}
async function totpSetup(uid: number) {
  const acc = (await db("rdx_accounts?select=totp_secret,username&user_id=eq." + uid))?.[0] || {};
  let secret = acc.totp_secret;
  if (!secret) { secret = b32enc(crypto.getRandomValues(new Uint8Array(20))); await patch("rdx_accounts?user_id=eq." + uid, { totp_secret: secret }); }
  return { secret, uri: "otpauth://totp/" + encodeURIComponent("RDX Squad:" + (acc.username || uid)) + "?secret=" + secret + "&issuer=RDX%20Squad&digits=6&period=30" };
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
    const adm = [{ command: "apps", description: "Новые заявки" }, { command: "roster", description: "Состав" }, { command: "admin", description: "Все команды" }];
    await tg("main", "setMyCommands", { commands: [...cmdsMain, ...adm], scope: { type: "chat", chat_id: id } });
    await tg("ai", "setMyCommands", { commands: [...cmdsAI, { command: "admin", description: "Команды командира" }], scope: { type: "chat", chat_id: id } });
  }
  await tg("main", "setChatMenuButton", { menu_button: { type: "web_app", text: "Сайт RDX", web_app: { url: SITE_APP } } });
  await tg("main", "setMyName", { name: "RDX Squad" });
  await tg("main", "setMyShortDescription", { short_description: "RDX Squad — Revolvers and Explosives. Заявка в сквад, обжалование бана, RDX_AI." });
  await tg("main", "setMyDescription", { description: "Бот сквада RDX (Revolvers and Explosives) в Animal Company.\n\n📝 Заявка в сквад\n⚖️ Обжалование бана\n🆘 Связь с командирами\n🤖 RDX_AI\n\nНажми «Старт»." });
  await tg("ai", "setMyName", { name: "RDX_AI" });
  await tg("ai", "setMyShortDescription", { short_description: "ИИ-помощник RDX Squad. На обычном тарифе — 5 вопросов." });
  await tg("ai", "setMyDescription", { description: "RDX_AI — ИИ-помощник сквада RDX Squad (Revolvers and Explosives).\nОтвечает коротко и по делу. На обычном тарифе — 5 вопросов за 5 часов." });
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
  if (typeof b?.type === "string" && b.type.startsWith("acc_")) return await accApi(req, b).catch((e) => { console.error("acc", e); return accJ({ ok: false, error: "err" }, 500); });
  if (b?.type === "mail_test") {   // проверка почты (внутренний ключ)
    if (!HOOK || req.headers.get("x-rdx-int") !== HOOK) return new Response("no", { status: 403 });
    try { await smtpSend(String(b.to), "RDX Squad — проверка почты", mailHtml("Почта работает", "✅", "Это тестовое письмо: теперь все письма сайта RDX приходят от RDX Squad."), "Почта RDX работает."); return new Response(JSON.stringify({ ok: true, on: SMTP_ON() })); }
    catch (e) { return new Response(JSON.stringify({ ok: false, on: SMTP_ON(), err: String(e).slice(0, 200) })); }
  }
  if (b?.type === "clan") {   // SealsAI просит действие с составом клана (внутренний ключ)
    if (!HOOK || req.headers.get("x-rdx-int") !== HOOK) return new Response("no", { status: 403 });
    const actor = { id: Number(b.actor?.id), username: b.actor?.username || null, first_name: b.actor?.first_name || null };
    const r = await clanApi(actor, String(b.act || ""), String(b.q || ""), b.rank === undefined || b.rank === null ? null : Number(b.rank), b.value ?? null).catch((e) => ({ ok: false, text: "ошибка: " + String(e).slice(0, 100) }));
    return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
  }
  if (b?.type === "stats") return new Response(JSON.stringify({ ok: true, members: await membersCount(), efficiency: 100 }), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "max-age=30" } });
  if (b?.type === "get" || b?.type === "edit") {
    const r: any = await (b.type === "get" ? siteGet(req, b) : siteEdit(req, b)).catch((e) => { console.error("edit", e); return { ok: false, error: "err" }; });
    return new Response(JSON.stringify(r), { status: r.status || (r.ok ? 200 : 400), headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (b?.type === "apply") {
    const r: any = await siteApply(req, b).catch((e) => { console.error("apply", e); return { ok: false, error: "err" }; });
    return new Response(JSON.stringify(r), { status: r.status || (r.ok ? 200 : 400), headers: { ...CORS, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
});
