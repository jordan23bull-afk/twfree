/**
 * Отбор акций MOEX (TQBR) и запись data.json, который читает rosn.html.
 *   node screener.mjs
 *   node screener.mjs --value 5000000 --atr 100 --days 60
 */
import { writeFile } from 'node:fs/promises';

const ISS = 'https://iss.moex.com/iss';
const BOARD = 'stock/markets/shares/boards/TQBR';
const HISTORY_ALL = `${ISS}/history/engines/${BOARD}/securities.json`;
const BOARD_SECURITIES = `${ISS}/engines/${BOARD}/securities.json`;

// Пороги отбора
const DEFAULTS = {
  minValue: 10_000_000, // минимальный оборот за день, руб.
  minAtr: 150, // минимальный ATR в шагах цены
  historyDays: 30, // сколько дней истории класть в файл
  maxLookback: 10, // сколько дней назад искать последнюю торговую сессию
  secTypes: '1,2' // какие типы бумаг допускать, см. SECTYPE ниже
};

/**
 * Коды SECTYPE в ISS для рынка акций:
 *   1 — обыкновенная акция      2 — привилегированная акция
 *   J — ETF (биржевой фонд)     A — ИПИФ, ЗПИФ, прочие фонды
 *   B — облигация, ЗПИФ         9 — ЦФА (цифровые финансовые активы)
 *   D — депозитарная расписка (ГДР)
 * По умолчанию берём только 1 и 2 — то есть акции. ETF, ПИФы, облигации,
 * ЦФА и расписки отсеиваются.
 */
/** Разбирает "1,2" в Set кодов SECTYPE. */
function parseTypes(spec) {
  return new Set(String(spec).split(',').map(s => s.trim()).filter(Boolean));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

const iso = d => d.toISOString().slice(0, 10);

/**
 * Последняя торговая сессия. За текущий день ISS отдаёт ноль строк,
 * поэтому ищем назад от сегодня — иначе в выходные скрипт упадёт.
 */
async function findLastTradingDate(maxLookback = DEFAULTS.maxLookback) {
  const probe = iso(new Date(Date.now() - 3 * 6.4e5)); // 3 дня назад
  const { dates } = await getJson(`${ISS}/history/engines/${BOARD}/dates.json?from=${probe}&iss.meta=off`);
  if (dates?.data?.[0]?.[1]) return dates.data[0][1];
  // запасной путь: перебор назад, если блок дат недоступен
  for (let i = 0; i < maxLookback; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const day = iso(d);
    const j = await getJson(`${HISTORY_ALL}?date=${day}&iss.meta=off&start=0&history.columns=SECID`);
    if (j.history?.data?.length) return day;
  }
  throw new Error('Не нашлась ни одна торговая сессия');
}

/** Все акции площадки за конкретный день. ISS отдаёт по 100 строк. */
async function fetchDayRows(date) {
  const cols = 'SECID,SHORTNAME,OPEN,LOW,HIGH,CLOSE,VOLUME,VALUE';
  const out = [];
  for (let start = 0; start < 5000; start += 100) {
    const j = await getJson(`${HISTORY_ALL}?date=${date}&iss.meta=off&start=${start}&history.columns=${cols}`);
    if (!j.history?.data) break;
    for (const row of j.history.data) {
      const o = {};
      j.history.columns.forEach((c, i) => (o[c] = row[i]));
      out.push(o);
    }
    if (j.history.data.length < 100) break;
  }
  if (!out.length) throw new Error(`Пустой ответ истории за ${date}`);
  return out;
}

/**
 * MINSTEP и SECTYPE для всех тикеров площадки: шаг цены и тип бумаги
 * нужны каждому тикеру свои, и одним запросом мы их получаем вместе.
 */
async function fetchSecurities() {
  const j = await getJson(
    `${BOARD_SECURITIES}?iss.meta=off&iss.only=securities&securities.columns=SECID,MINSTEP,SECTYPE`
  );
  const map = new Map();
  for (const row of j.securities.data) map.set(row[0], { minstep: Number(row[1]), sectype: String(row[2] ?? '') });
  return map;
}

/**
 * Отбор: тип бумаги -> оборот и объём -> ATR в шагах цены -> цвет флага.
 * ATR = (HIGH - LOW) / MINSTEP, то есть в пунктах, а не в рублях.
 * stats.type — сколько тикеров отсеяно по типу бумаги.
 */
function select(rows, securities, opts = {}) {
  const { minValue, minAtr } = { ...DEFAULTS, ...opts };
  const allowed = parseTypes(opts.secTypes ?? DEFAULTS.secTypes);
  const out = [];
  const stats = { type: 0, turnover: 0, atr: 0 };
  for (const r of rows) {
    const sec = securities.get(r.SECID);
    if (!sec || !allowed.has(sec.sectype)) { stats.type++; continue; }
    if (!(Number(r.VALUE) >= minValue) || !(Number(r.VOLUME) > 0)) { stats.turnover++; continue; }
    if (!sec.minstep) continue;
    const high = Number(r.HIGH);
    const low = Number(r.LOW);
    if (!(high > 0) || !(low > 0)) continue;
    const atr = (high - low) / sec.minstep;
    if (atr < minAtr) { stats.atr++; continue; }
    const close = Number(r.CLOSE);
    const open = Number(r.OPEN);
    out.push({
      secid: r.SECID,
      name: r.SHORTNAME || '',
      atr: Math.round(atr * 10) / 10,
      step: sec.minstep,
      // CLOSE > OPEN — зелёный, иначе красный (включая равные свечи)
      flag: close > open ? 'green' : 'red',
      change: open ? Math.round(((close - open) / open) * 10000) / 100 : 0,
      close,
      value: Number(r.VALUE)
    });
  }
  // Сначала самые волатильные — их интереснее смотреть
  out.sort((a, b) => b.atr - a.atr);
  return { picked: out, stats };
}

/** Дневная история по одному тикеру. */
async function fetchCandles(secid, from, till) {
  const cols = 'TRADEDATE,OPEN,LOW,HIGH,CLOSE,VOLUME';
  const j = await getJson(
    `${ISS}/history/engines/${BOARD}/securities/${secid}.json?from=${from}&till=${till}` +
      `&iss.meta=off&iss.only=history&history.columns=${cols}`
  );
  if (!j.history?.data) return [];
  const idx = {};
  j.history.columns.forEach((c, i) => (idx[c] = i));
  return j.history.data
    .map(r => ({
      time: Date.parse(String(r[idx.TRADEDATE]).replace(/-/g, '/')) / 1000,
      open: Number(r[idx.OPEN]),
      high: Number(r[idx.HIGH]),
      low: Number(r[idx.LOW]),
      close: Number(r[idx.CLOSE]),
      volume: Number(r[idx.VOLUME]) || 0
    }))
    .filter(c => Number.isFinite(c.time) && c.open > 0)
    .sort((a, b) => a.time - b.time);
}

/** Дата на days календарных дней раньше (историю берём с запасом). */
function shiftDate(dateStr, days) {
  const d = new Date(dateStr.replace(/-/g, '/'));
  d.setDate(d.getDate() - days);
  return iso(d);
}

/** Отбор + история для графика. */
async function run(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const date = await findLastTradingDate();
  const rows = await fetchDayRows(date);
  const securities = await fetchSecurities();
  const { picked, stats } = select(rows, securities, o);
  const from = shiftDate(date, Math.ceil(o.historyDays * 1.6));
  const candles = {};
  for (const p of picked) {
    try {
      candles[p.secid] = await fetchCandles(p.secid, from, date);
    } catch {
      candles[p.secid] = [];
    }
  }
  return {
    tradedate: date,
    generated: new Date().toISOString(),
    params: {
      minValue: o.minValue,
      minAtr: o.minAtr,
      historyDays: o.historyDays,
      secTypes: o.secTypes
    },
    counts: { total: rows.length, picked: picked.length, ...stats },
    watchlist: picked,
    candles
  };
}

/* ================= запуск из командной строки ================= */

/** Числовой аргумент: --value 5000000 */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

/** Строковый аргумент: --types 1,2 (значение не обязано быть числом) */
function argStr(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const opts = {
  minValue: arg('value', DEFAULTS.minValue),
  minAtr: arg('atr', DEFAULTS.minAtr),
  historyDays: arg('days', DEFAULTS.historyDays),
  secTypes: argStr('types', DEFAULTS.secTypes)
};

const log = (...a) => console.log(...a);

log('Отбор акций MOEX, TQBR');
log(`  оборот от ${opts.minValue.toLocaleString('ru')} руб.`);
log(`  ATR от ${opts.minAtr} пунктов`);
log(`  история ${opts.historyDays} торговых дней`);
log(`  типы бумаг: ${[...parseTypes(opts.secTypes)].join(', ')} (1 = ао, 2 = ап)`);
log('');

try {
  const data = await run(opts);
  const json = JSON.stringify(data);
  await writeFile(new URL('./data.json', import.meta.url), json, 'utf8');

  log(`Торговая сессия: ${data.tradedate}`);
  log(`Акций в отборе: ${data.counts.picked} из ${data.counts.total}`);
  log(`  отсеяно: не та бумага (ETF/ПИФ/облигация/расписка) — ${data.counts.type}, оборот — ${data.counts.turnover}, ATR — ${data.counts.atr}`);
  const green = data.watchlist.filter(w => w.flag === 'green').length;
  log(`  зелёных: ${green}, красных: ${data.counts.picked - green}`);
  log(`data.json: ${(json.length / 1024).toFixed(1)} КБ`);

  for (const w of data.watchlist.slice(0, 10)) {
    log(`  ${w.flag === 'green' ? '+' : '-'} ${w.secid.padEnd(8)} ATR ${String(w.atr).padStart(7)}  ${w.change > 0 ? '+' : ''}${w.change}%  ${w.name}`);
  }
  if (data.watchlist.length > 10) log(`  ...ещё ${data.watchlist.length - 10}`);
  log('');
  log('Готово.');
} catch (e) {
  console.error('Ошибка:', e.message);
  process.exit(1);
}
