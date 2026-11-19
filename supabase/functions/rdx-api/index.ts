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
async function tierOf(uid: number, withMod = true) {
  const r = await db("rdx_premium?select=tier,until&user_id=eq." + uid + "&until=gt." + enc(new Date().toISOString()));
  const own = r?.[0] ? { tier: String(r[0].tier), until: String(r[0].until) as string | null } : { tier: "base", until: null as string | null };
  // модератор получает уровень «Модератор», если его собственный уровень ниже
  if (withMod && (await modIds()).includes(uid) && higher("mod", own.tier) === "mod") return { tier: "mod", until: null };
  // боец клана получает уровень «Боец RDX», если его собственный уровень ниже
  if (withMod && higher("clan", own.tier) === "clan" && own.tier !== "clan" && await isMember(uid)) return { tier: "clan", until: null };
  return own;
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
  if (q.unlimited) return "♾ <b>Безлимит</b>";
  const name = (TIERS[q.tier] || TIERS.base).name;
  return (q.tier === "mod" ? "🛡 " : "🪙 ") + "<b>RDX_AI · " + name + "</b>" + (q.until ? " до " + new Date(Date.parse(q.until) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " МСК" : "")
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
async function askAI(bot: Bot, chat: number, from: any, text: string, replyTo?: number) {
  const ci = await clanIntent(from, text).catch((e) => { console.error("clan", e); return null; });
  if (ci) return send(bot, chat, ci, replyTo ? { reply_parameters: { message_id: replyTo } } : {});
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
const clanAll = async (): Promise<any[]> => await db("rdx_members?select=id,user_id,username,nick,joined_at,app_id&active=eq.true&order=joined_at") || [];
const memRows = (list: any[]) => list.map((x) => [["🎖 " + memName(x).slice(0, 48), "cl:m:" + x.id]] as [string, string][]);
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
async function clanCard(chat: number, id: number) {
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active) return send("main", chat, "Этого бойца уже нет в составе.", kb([[["👥 Состав", "cl:list"]]]));
  const tr = x.user_id ? await tierOf(Number(x.user_id)) : null;
  const d = String(x.joined_at || "").slice(0, 10).split("-").reverse().join(".");
  await send("main", chat, "🎖 <b>" + esc(x.nick || "Боец") + "</b>" + (x.username ? " · @" + esc(x.username) : "") + "\nВ составе с " + d + (x.app_id ? " · заявка #" + x.app_id : "")
    + (tr ? "\nУровень: " + (TIERS[tr.tier] || TIERS.base).name : "\nTelegram не привязан — сообщения от ботов ему не дойдут"),
    kb([[["🚫 Бан", "cl:ask:ban:" + id], ["👢 Кик", "cl:ask:kick:" + id]], [["📄 Уволить (по заявлению)", "cl:ask:fire:" + id]], [["👥 К списку", "cl:list"]]]));
}
const CLAN_ACT: Record<string, [string, string, string]> = {
  ban: ["🚫 Забанить", "Бан: человек уйдёт из состава, а боты RDX, RDX_AI и SealsAI перестанут ему отвечать.", "🚫 забанен"],
  kick: ["👢 Кикнуть", "Кик: человек уйдёт из состава, бот напишет ему «Ты был выгнан из клана».", "👢 выгнан из клана"],
  fire: ["📄 Уволить", "Увольнение по заявлению: бот официально сообщит, что заявление рассмотрено и он уволен.", "📄 уволен"],
};
// действие над бойцом: ban | kick | fire. actor — кто просит (создатель или модератор)
async function clanAct(actor: any, act: string, id: number): Promise<{ ok: boolean; text: string }> {
  const x = (await db("rdx_members?select=*&id=eq." + id))?.[0];
  if (!x || !x.active || !CLAN_ACT[act]) return { ok: false, text: "Этого бойца уже нет в составе." };
  if (!(await isMod(actor))) return { ok: false, text: "Это могут только создатель и модераторы RDX." };
  const tid = x.user_id ? Number(x.user_id) : null;
  if ((tid && ADMINS.includes(tid)) || /^mr_wugi4$/i.test(x.username || "")) return { ok: false, text: "👑 Создателя убрать нельзя." };
  if (tid === Number(actor.id)) return { ok: false, text: "Себя убрать нельзя — подай заявление на выход через меню бота RDX." };
  if (!isOwner(actor) && tid && (await modIds()).includes(tid)) return { ok: false, text: "Модератора может убрать только создатель." };
  await patch("rdx_members?id=eq." + id, { active: false, left_at: new Date().toISOString() });
  if (act === "ban") { await ins("rdx_bans", [{ user_id: tid, username: x.username || null, nick: x.nick || null, by_id: Number(actor.id) }], "return=minimal"); BANS = null; }
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
const memLine = (x: any) => "• " + esc(x.nick || "Боец") + (x.username ? " (@" + esc(x.username) + ")" : "") + (x.user_id ? "" : " — Telegram не привязан");
// общий вход: list | find | ban | kick | fire (для RDX_AI и SealsAI)
async function clanApi(actor: any, act: string, q: string): Promise<{ ok: boolean; text: string }> {
  if (act === "list") {
    const all = await clanAll();
    if (all.length > CLAN_BIG) return { ok: true, text: "👥 В строю клана RDX: <b>" + all.length + "</b>. Полный список — кнопка «👥 Состав клана» в боте RDX." };
    return { ok: true, text: "👥 <b>Состав клана RDX</b> — в строю " + all.length + ":\n" + all.map(memLine).join("\n") };
  }
  const f = await findMembers(q);
  if (act === "find") return f.length ? { ok: true, text: "🔎 Нашёл в составе:\n" + f.slice(0, 20).map(memLine).join("\n") } : { ok: false, text: "В составе RDX нет никого по «" + esc(q) + "»." };
  if (!CLAN_ACT[act]) return { ok: false, text: "Не понял действие." };
  if (!f.length) return { ok: false, text: "В составе RDX нет никого по «" + esc(q) + "»." };
  if (f.length > 1) return { ok: false, text: "Под «" + esc(q) + "» подходят несколько бойцов — уточни ник:\n" + f.slice(0, 10).map(memLine).join("\n") };
  return await clanAct(actor, act, Number(f[0].id));
}
// просьба обычными словами в RDX_AI: «забань Аркадия», «кикни @ник», «уволь Глеба», «найди Никиту», «кто в составе»
async function clanIntent(u: any, text: string): Promise<string | null> {
  const tl = text.toLowerCase().replace(/ё/g, "е");
  const verbs: [RegExp, string][] = [[/(^|\s)(забан\S*|бан|заблокир\S*)(\s|$)/, "ban"], [/(^|\s)(кикн\S*|кик|выгон\S*|выгна\S*|выкин\S*)(\s|$)/, "kick"], [/(^|\s)(уволь\S*|уволи\S*)(\s|$)/, "fire"], [/(^|\s)(найди|найти|поищи|ищи)(\s|$)/, "find"]];
  let act = "", vm: RegExpMatchArray | null = null;
  for (const [re, a] of verbs) { const m = tl.match(re); if (m) { act = a; vm = m; break; } }
  const aboutClan = /(клан|состав|сквад|склад|rdx|рдх|строю)/.test(tl);
  if (!act && aboutClan && /(кто|список|покажи|сколько)/.test(tl)) act = "list";
  if (!act || (act === "find" && !aboutClan && !/@\w/.test(text))) return null;
  if (act === "list") return (await clanApi(u, "list", "")).text;
  const at = text.match(/@([A-Za-z0-9_]{3,32})/);
  const after = tl.slice((vm!.index || 0) + vm![0].length).split(/[\s,.!?]+/).filter((w) => w && !/^(из|с|со|клана|клане|состава|составе|сквада|скваде|склада|скаде|rdx|рдх|пожалуйста|плиз|игрока|бойца|его|ее|этого|мне|нам)$/.test(w));
  const q = at ? at[1] : after[0] || "";
  if (!q) return null;   // «как обжаловать бан?» — это вопрос, а не просьба
  if (!at && !(await findMembers(q)).length) return null;
  if (act !== "find" && !(await isMod(u))) return "Банить, кикать и увольнять из клана могут только создатель и модераторы RDX.";
  return (await clanApi(u, act, q)).text;
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
    const st = await getState("main", u.id);
    if (data.startsWith("cl:")) {
      if (!(await isMod(u))) return;
      const [, op, a1, a2] = data.split(":");
      if (st?.flow === "clfind" && op !== "find") await setState("main", u.id, null);
      if (op === "list") return clanShow(chat, null);
      if (op === "all") return clanShow(chat, Number(a1) || 0);
      if (op === "find") { await setState("main", u.id, "clfind", 0, {}); return send("main", chat, "🔎 Напиши ник бойца или его часть:", kb([[["✖️ Отмена", "cl:list"]]])); }
      if (op === "m") return clanCard(chat, Number(a1));
      if (op === "ask" && CLAN_ACT[a1]) {
        const x = (await db("rdx_members?select=nick,username,active&id=eq." + Number(a2)))?.[0];
        if (!x?.active) return send("main", chat, "Этого бойца уже нет в составе.");
        return send("main", chat, CLAN_ACT[a1][0] + " <b>" + esc(memName(x)) + "</b>?\n" + CLAN_ACT[a1][1], kb([[["✅ Да", "cl:do:" + a1 + ":" + Number(a2)], ["✖️ Нет", "cl:m:" + Number(a2)]]]));
      }
      if (op === "do") {
        await tg("main", "editMessageReplyMarkup", { chat_id: chat, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
        return clanDo(u, chat, a1, Number(a2));
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
        await ins("rdx_members", [{ user_id: uid, username: a.username || a.data?.tg || null, nick: a.data?.nick || null, app_id: a.id, active: true }], "return=minimal");
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
    return startFlow(u, chat, ["apply", "appeal", "help", "ai"].includes(arg) ? arg : "menu");
  }
  if (text === "/menu" || text === "/cancel") return startFlow(u, chat, "menu");
  if (text === "/tokens") return send("main", chat, await tokensText(u.id));
  if (/^\/promo(@\S+)?\b/i.test(text) || PROMO_RE.test(text)) {
    const c = text.match(PROMO_RE);
    return send("main", chat, c ? await redeemRdxPromo(u.id, c[0]) : "Напиши так: /promo RDX-XXXX-XXXX");
  }
  if (await tryModKey("main", m)) return;
  if ((text.startsWith("/") && await isMod(u) || isOwner(u) && modIntent(text)) && await adminCmd("main", u, chat, text)) return;
  const st = await getState("main", u.id);
  if (!text) return;
  if (st?.flow === "clfind" && await isMod(u)) { await setState("main", u.id, null); return clanFind(chat, text); }
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
  if ((text.startsWith("/") && await isMod(u) || isOwner(u) && modIntent(text)) && await adminCmd("ai", u, chat, text)) return;
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
      const left = MOD_TOKENS_DAY - await modUsed(u.id, "tokens", 86400e3);
      if (lim && n > left) { await say("Можно раздать ещё " + Math.max(0, left) + " из " + MOD_TOKENS_DAY + " на сегодня."); return true; }
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
  if (owner && cmd === "/promo_new") {   // создатель: /promo_new vip|premium|plus|ultra|max дней [штук]
    const tier = String(args[0] || "").toLowerCase(), days = Number(args[1]), cnt = Math.max(1, Math.min(50, Number(args[2]) || 1));
    if (!TIERS[tier] || tier === "base" || tier === "mod" || tier === "clan" || !(days > 0)) { await say("Пример: /promo_new plus 30 5 — 5 кодов Premium Plus на 30 дней"); return true; }
    const codes = await makePromos(tier, days, cnt, u.id);
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
    await say("<b>Команды создателя</b>\nКнопка «👥 Состав клана» в меню — список, поиск, бан, кик, увольнение\n/apps — новые заявки\n/roster — состав · /fire @ник — исключить\n/addmember @ник Имя — добавить в состав (или привязать Telegram)\n/bans — забаненные · /unban @ник — разбанить\n/mods — модераторы · /unmod @ник — снять\n/promo_new уровень дней [штук] — промокоды RDX_AI\n/makemod @ник — назначить модератора (или просто напиши «дай модера @ник»)\n/give @ник N · /vip @ник дней · /vippromo дней — как у модератора, но без лимитов\n/tokens @ник — вопросы у человека\n/reset @ник — восстановить вопросы\n/add @ник 10 [дней] — добавить вопросы\n/unlim @ник [дней|off] — безлимит\n/grant @ник vip|premium|plus|ultra|max [дней|навсегда] — привилегия\n/grant @ник none — снять");
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
  if (b?.type === "clan") {   // SealsAI просит действие с составом клана (внутренний ключ)
    if (!HOOK || req.headers.get("x-rdx-int") !== HOOK) return new Response("no", { status: 403 });
    const actor = { id: Number(b.actor?.id), username: b.actor?.username || null, first_name: b.actor?.first_name || null };
    const r = await clanApi(actor, String(b.act || ""), String(b.q || "")).catch((e) => ({ ok: false, text: "ошибка: " + String(e).slice(0, 100) }));
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
