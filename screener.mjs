/**
 * Отбор акций MOEX (TQBR) и запись data.json, который читает rosn.html.
 *   node screener.mjs
 *   node screener.mjs --value 5000000 --atr 100 --days 60
 */
import { writeFile } from 'node:fs/promises';

const ISS = 'https://iss.moex.com/iss';

/**
 * Площадки ISS. Путь движка/рынка/площадки разный, поэтому он хранится
 * рядом с тикером: у каждого бумаги свой ISS_PATH, и rosn.html берёт
 * тот же путь из data.json, чтобы дорисовать недостающие таймфреймы.
 */
const BOARDS = {
  shares: 'stock/markets/shares/boards/TQBR',
  forts: 'futures/markets/forts/boards/RFUD'
};
const BOARD = BOARDS.shares;
const HISTORY_ALL = `${ISS}/history/engines/${BOARD}/securities.json`;
const BOARD_SECURITIES = `${ISS}/engines/${BOARD}/securities.json`;

/**
 * Фьючерсы, которые добавляются в вочлист всегда, независимо от порогов
 * отбора: оборот и ATR считаются для них так же, но отсев по обороту
 * и минимальному ATR к ним не применяется.
 */
const EXTRA_FUTURES = ['IMOEXF', 'MXZ6'];

// Пороги отбора
const DEFAULTS = {
  minValue: 10_000_000, // минимальный оборот за день, руб.
  minAtr: 150, // минимальный ATR в шагах цены
  historyDays: 30, // сколько дней истории класть в файл
  maxLookback: 10, // сколько дней назад искать последнюю торговую сессию
  secTypes: '1,2', // какие типы бумаг допускать, см. SECTYPE ниже
  poc: true, // считать ли POC последнего дня из минутных свечей
  futures: true // добавлять ли фьючерсы из EXTRA_FUTURES
};

/**
 * ISS отдаёт числа с запятой как десятичным разделителем: "2248,00000".
 * Number() на такой строке даёт NaN, поэтому запятую приводим к точке.
 * Точка и пустая строка уже обрабатываются Number как надо.
 */
const num = v => Number(String(v ?? '').replace(',', '.'));

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

/** Все бумаги площадки за конкретный день. ISS отдаёт по 100 строк. */
async function fetchDayRows(date, board = BOARD) {
  const cols = 'SECID,SHORTNAME,OPEN,LOW,HIGH,CLOSE,VOLUME,VALUE';
  const out = [];
  for (let start = 0; start < 5000; start += 100) {
    const url =
      `${ISS}/history/engines/${board}/securities.json` +
      `?date=${date}&iss.meta=off&start=${start}&history.columns=${cols}`;
    const j = await getJson(url);
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
async function fetchSecurities(board = BOARD) {
  const j = await getJson(
    `${ISS}/engines/${board}/securities.json` +
      `?iss.meta=off&iss.only=securities&securities.columns=SECID,SHORTNAME,MINSTEP,SECTYPE`
  );
  const map = new Map();
  for (const row of j.securities.data) {
    map.set(row[0], { minstep: num(row[2]), sectype: String(row[3] ?? ''), name: String(row[1] ?? '') });
  }
  return map;
}

/**
 * Отбор: тип бумаги -> оборот и объём -> ATR в шагах цены -> цвет флага.
 * ATR = (HIGH - LOW) / MINSTEP, то есть в пунктах, а не в рублях.
 * stats.type — сколько тикеров отсеяно по типу бумаги.
 *
 * board добавляется в карточку тикера: rosn.html по нему строит адрес ISS
 * для остальных таймфреймов, поэтому фьючерс отличается от акции путём.
 */
function select(rows, securities, opts = {}) {
  const { minValue, minAtr, board = BOARD, mandatory = null } = { ...DEFAULTS, ...opts };
  const allowed = parseTypes(opts.secTypes ?? DEFAULTS.secTypes);
  const out = [];
  const stats = { type: 0, turnover: 0, atr: 0, extra: 0 };
  for (const r of rows) {
    const sec = securities.get(r.SECID);
    if (!sec) continue;
    // Обязательные тикеры (фьючерсы) идут в список всегда: MINSTEP у них
    // свой, а отсев по обороту и ATR к ним не применяется.
    const forced = mandatory !== null && mandatory.includes(r.SECID);
    if (!forced) {
      if (!allowed.has(sec.sectype)) { stats.type++; continue; }
      if (!(num(r.VALUE) >= minValue) || !(num(r.VOLUME) > 0)) { stats.turnover++; continue; }
    }
    if (!sec.minstep) { if (forced) stats.extra++; continue; }
    const high = num(r.HIGH);
    const low = num(r.LOW);
    if (!(high > 0) || !(low > 0)) { if (forced) stats.extra++; continue; }
    const atr = (high - low) / sec.minstep;
    if (!forced && atr < minAtr) { stats.atr++; continue; }
    const close = num(r.CLOSE);
    const open = num(r.OPEN);
    out.push({
      secid: r.SECID,
      name: r.SHORTNAME || sec.name || '',
      board,
      atr: Math.round(atr * 10) / 10,
      step: sec.minstep,
      // CLOSE > OPEN — зелёный, иначе красный (включая равные свечи)
      flag: close > open ? 'green' : 'red',
      change: open ? Math.round(((close - open) / open) * 10000) / 100 : 0,
      close,
      value: num(r.VALUE)
    });
  }
  // Сначала самые волатильные — их интереснее смотреть
  out.sort((a, b) => b.atr - a.atr);
  return { picked: out, stats };
}

/**
 * Дата торгов "2026-09-28" -> метка UTC-полночи этой даты.
 * Важно строить именно UTC: Date.parse с локальным временем сдвинул бы
 * дату на сутки назад, и в графике не было бы свечи за нужный день.
 */
function tradeDateToUtc(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

/** Дневная история по одному тикеру. */
async function fetchCandles(secid, from, till, board = BOARD) {
  const cols = 'TRADEDATE,OPEN,LOW,HIGH,CLOSE,VOLUME';
  const j = await getJson(
    `${ISS}/history/engines/${board}/securities/${secid}.json?from=${from}&till=${till}` +
      `&iss.meta=off&iss.only=history&history.columns=${cols}`
  );
  if (!j.history?.data) return [];
  const idx = {};
  j.history.columns.forEach((c, i) => (idx[c] = i));
  return j.history.data
    .map(r => ({
      time: tradeDateToUtc(r[idx.TRADEDATE]),
      open: num(r[idx.OPEN]),
      high: num(r[idx.HIGH]),
      low: num(r[idx.LOW]),
      close: num(r[idx.CLOSE]),
      volume: num(r[idx.VOLUME]) || 0
    }))
    .filter(c => Number.isFinite(c.time) && c.open > 0)
    .sort((a, b) => a.time - b.time);
}

/** Дата на days календарных дней раньше (историю берём с запасом). */
function shiftDate(dateStr, days) {
  return iso(new Date(tradeDateToUtc(dateStr) * 1000 - days * 864e5));
}

/**
 * Минутные свечи за один день. ISS отдаёт по 500 строк, поэтому листаем start.
 * У блока candles нет колонки time — время бара лежит в begin.
 */
async function fetchDayMinutes(secid, date, board = BOARD, maxPages = 12) {
  const out = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const j = await getJson(
      `${ISS}/engines/${board}/securities/${secid}/candles.json` +
        `?interval=1&from=${date}&till=${date}&start=${start}&iss.meta=off`
    );
    const b = j.candles;
    if (!b?.data?.length) break;
    const idx = {};
    b.columns.forEach((c, i) => (idx[c] = i));
    for (const r of b.data) {
      out.push({
        high: num(r[idx.high]),
        low: num(r[idx.low]),
        volume: num(r[idx.volume]) || 0
      });
    }
    if (b.data.length < 500) break;
    start += b.data.length;
  }
  return out;
}

/**
 * POC дня: цена с наибольшим объёмом.
 *
 * Внутри минуты распределение объёма по ценам неизвестно, поэтому считаем
 * равномерным по диапазону бара [low, high]. Чтобы не перебирать каждый шаг
 * для каждой минуты, копим разности: минута вносит volume/число_шагов в
 * каждый шаг своего диапазона, дальше один проход префиксной суммой.
 * Шаг корзины — MINSTEP, то есть минимальное движение цены биржи.
 */
function computePoc(minutes, minstep) {
  if (!minutes.length || !(minstep > 0)) return null;
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (const m of minutes) {
    if (!(m.low > 0) || !(m.high > 0) || !(m.volume > 0)) continue;
    if (m.low < lo) lo = m.low;
    if (m.high > hi) hi = m.high;
    total += m.volume;
  }
  if (!Number.isFinite(lo) || !(total > 0)) return null;

  const from = Math.floor(lo / minstep);
  const to = Math.ceil(hi / minstep);
  const size = to - from + 1;
  if (!(size > 0) || size > 5_000_000) return null;
  const diff = new Float64Array(size + 1);

  for (const m of minutes) {
    if (!(m.low > 0) || !(m.high > 0) || !(m.volume > 0)) continue;
    const a = Math.max(from, Math.floor(m.low / minstep));
    const b = Math.min(to, Math.ceil(m.high / minstep));
    if (b < a) continue;
    const share = m.volume / (b - a + 1);
    diff[a - from] += share;
    diff[b - from + 1] -= share;
  }

  let acc = 0;
  let bestVol = -1;
  let bestIdx = -1;
  for (let i = 0; i < size; i++) {
    acc += diff[i];
    if (acc > bestVol) { bestVol = acc; bestIdx = i; }
  }
  if (bestIdx < 0 || !(bestVol > 0)) return null;

  return {
    price: Math.round((from + bestIdx) * minstep * 1e6) / 1e6,
    vol: bestVol,
    // какая доля дневного объёма прошла по цене POC
    share: Math.round((bestVol / total) * 10000) / 100
  };
}

/** POC последнего дня для тикера; при неудаче — null, скрипт не падает. */
async function fetchPoc(secid, date, minstep, board) {
  try {
    return computePoc(await fetchDayMinutes(secid, date, board), minstep);
  } catch {
    return null;
  }
}

/** Отбор + история для графика. */
async function run(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const date = await findLastTradingDate();
  const rows = await fetchDayRows(date);
  const securities = await fetchSecurities();
  const { picked, stats } = select(rows, securities, o);

  // Фьючерсы: другая площадка и другой набор тикеров, но ATR и POC
  // считаются теми же функциями. Их не берёт findLastTradingDate для TQBR,
  // поэтому день берём тот же, что и для акций.
  const futures = [];
  if (o.futures && EXTRA_FUTURES.length) {
    try {
      const fRows = await fetchDayRows(date, BOARDS.forts);
      const fSec = await fetchSecurities(BOARDS.forts);
      const res = select(fRows, fSec, { ...o, board: BOARDS.forts, mandatory: EXTRA_FUTURES });
      futures.push(...res.picked);
      log(`  фьючерсы: ${res.picked.map(f => f.secid).join(', ') || '—'}`);
    } catch (e) {
      log(`  фьючерсы не получены: ${e.message}`);
    }
  }

  const all = [...futures, ...picked];
  const from = shiftDate(date, Math.ceil(o.historyDays * 1.6));
  const candles = {};
  for (const p of all) {
    try {
      candles[p.secid] = await fetchCandles(p.secid, from, date, p.board);
    } catch {
      candles[p.secid] = [];
    }
    // POC дня: цена, где накопилось больше всего объёма
    const poc = o.poc ? await fetchPoc(p.secid, date, p.step, p.board) : null;
    if (poc) {
      p.poc = poc.price;
      p.pocShare = poc.share;
      p.pocGap = p.close ? Math.round(((p.close - poc.price) / poc.price) * 10000) / 100 : 0;
    }
  }
  return {
    tradedate: date,
    generated: new Date().toISOString(),
    params: {
      minValue: o.minValue,
      minAtr: o.minAtr,
      historyDays: o.historyDays,
      secTypes: o.secTypes,
      poc: o.poc,
      futures: o.futures ? EXTRA_FUTURES : []
    },
    counts: {
      total: rows.length,
      picked: all.length,
      ...stats,
      futures: futures.length,
      withPoc: all.filter(p => typeof p.poc === 'number').length
    },
    watchlist: all,
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

/** Логический аргумент: --no-poc выключает расчёт POC */
function argBool(name, fallback) {
  if (process.argv.includes(`--no-${name}`)) return false;
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

const opts = {
  minValue: arg('value', DEFAULTS.minValue),
  minAtr: arg('atr', DEFAULTS.minAtr),
  historyDays: arg('days', DEFAULTS.historyDays),
  secTypes: argStr('types', DEFAULTS.secTypes),
  poc: argBool('poc', DEFAULTS.poc),
  futures: argBool('futures', DEFAULTS.futures)
};

const log = (...a) => console.log(...a);

log('Отбор акций MOEX, TQBR + фьючерсы RFUD');
log(`  оборот от ${opts.minValue.toLocaleString('ru')} руб.`);
log(`  ATR от ${opts.minAtr} пунктов`);
log(`  история ${opts.historyDays} торговых дней`);
log(`  типы бумаг: ${[...parseTypes(opts.secTypes)].join(', ')} (1 = ао, 2 = ап)`);
log(`  фьючерсы всегда: ${opts.futures ? EXTRA_FUTURES.join(', ') : 'нет'}`);
log(`  POC последнего дня: ${opts.poc ? 'да' : 'нет'}`);
log('');

try {
  const data = await run(opts);
  const json = JSON.stringify(data);
  await writeFile(new URL('./data.json', import.meta.url), json, 'utf8');

log(`Торговая сессия: ${data.tradedate}`);
log(`Акций в отборе: ${data.counts.picked} из ${data.counts.total}`);
log(`  отсеяно: не та бумага (ETF/ПИФ/облигация/расписка) — ${data.counts.type}, оборот — ${data.counts.turnover}, ATR — ${data.counts.atr}`);
log(`  фьючерсов добавлено: ${data.counts.futures}`);
const green = data.watchlist.filter(w => w.flag === 'green').length;
log(`  зелёных: ${green}, красных: ${data.counts.picked - green}`);
if (opts.poc) log(`  POC посчитан: ${data.counts.withPoc} из ${data.counts.picked}`);
log(`data.json: ${(json.length / 1024).toFixed(1)} КБ`);

const show = w => {
  const poc = typeof w.poc === 'number' ? `  POC ${w.poc}` : '  POC —';
  const kind = w.board === BOARDS.shares ? '' : ' [ф]';
  log(`  ${w.flag === 'green' ? '+' : '-'} ${w.secid.padEnd(8)} ATR ${String(w.atr).padStart(7)}  ${w.change > 0 ? '+' : ''}${w.change}%${kind}  ${w.name}${poc}`);
};
for (const w of data.watchlist.slice(0, 10)) show(w);
if (data.watchlist.length > 10) {
  log(`  ...ещё ${data.watchlist.length - 10}`);
  for (const w of data.watchlist.filter(w => w.board !== BOARDS.shares)) show(w);
}
  if (data.watchlist.length > 10) log(`  ...ещё ${data.watchlist.length - 10}`);
  log('');
  log('Готово.');
} catch (e) {
  console.error('Ошибка:', e.message);
  process.exit(1);
}
