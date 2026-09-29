/**
 * Ядро отбора акций MOEX.
 * Одна реализация работает и в Node (screener.mjs), и в браузере (rosn.html).
 * fetch внедряется, потому что в браузере он глобальный, а в Node — из undici.
 */

export const ISS = 'https://iss.moex.com/iss';

const BOARD = 'stock/markets/shares/boards/TQBR';
const HISTORY_ALL = `${ISS}/history/engines/${BOARD}/securities.json`;
const BOARD_SECURITIES = `${ISS}/engines/${BOARD}/securities.json`;

// Пороги отбора
export const DEFAULTS = {
  minValue: 10_000_000, // минимальный оборот за день, руб.
  minAtr: 150, // минимальный ATR в пунктах (шагах цены)
  historyDays: 30, // сколько торговых дней истории класть в файл
  maxLookback: 10 // сколько дней назад искать последнюю торговую сессию
};

const pageSize = 500;

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
export async function findLastTradingDate(fetchFn = fetch, maxLookback = DEFAULTS.maxLookback) {
  const probe = iso(new Date(Date.now() - 3 * 6.4e5)); // 3 дня назад
  const { dates } = await getJson(`${ISS}/history/engines/${BOARD}/dates.json?from=${probe}&iss.meta=off`);
  if (dates && dates.data && dates.data[0]) {
    const found = dates.data[0][1];
    if (found) return found;
  }
  // Фоллбэк: перебор назад, если блок дат недоступен
  for (let i = 0; i < maxLookback; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const day = iso(d);
    const j = await getJson(`${HISTORY_ALL}?date=${day}&iss.meta=off&start=0&history.columns=SECID`);
    if (j.history && j.history.data && j.history.data.length) return day;
  }
  throw new Error('Не нашлась ни одна торговая сессия');
}

/** Все акции площадки за конкретный день, пагинация курсором. */
export async function fetchDayRows(date, fetchFn = fetch) {
  const cols = 'SECID,SHORTNAME,OPEN,LOW,HIGH,CLOSE,VOLUME,VALUE';
  const out = [];
  for (let start = 0; start < 5000; start += 100) {
    const j = await getJson(
      `${HISTORY_ALL}?date=${date}&iss.meta=off&start=${start}&history.columns=${cols}`
    );
    if (!j.history || !j.history.data) break;
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

/** Шаг цены (MINSTEP) для всех тикеров: у каждой бумаги он свой. */
export async function fetchSteps(fetchFn = fetch) {
  const j = await getJson(
    `${BOARD_SECURITIES}?iss.meta=off&iss.only=securities&securities.columns=SECID,MINSTEP`
  );
  const steps = {};
  for (const row of j.securities.data) steps[row[0]] = Number(row[1]);
  return steps;
}

/**
 * Отбор: оборот -> ATR в пунктах -> цвет флага.
 * ATR = (HIGH - LOW) / MINSTEP, то есть в шагах цены, а не в рублях.
 */
export function select(rows, steps, opts = {}) {
  const { minValue, minAtr } = { ...DEFAULTS, ...opts };
  const out = [];
  for (const r of rows) {
    const value = Number(r.VALUE);
    const volume = Number(r.VOLUME);
    if (!(value >= minValue) || !(volume > 0)) continue;
    const step = steps[r.SECID];
    if (!step) continue;
    const high = Number(r.HIGH);
    const low = Number(r.LOW);
    if (!(high > 0) || !(low > 0)) continue;
    const atr = (high - low) / step;
    if (atr < minAtr) continue;
    const close = Number(r.CLOSE);
    const open = Number(r.OPEN);
    out.push({
      secid: r.SECID,
      name: r.SHORTNAME || '',
      atr: Math.round(atr * 10) / 10,
      step,
      // CLOSE > OPEN — зелёный, иначе красный (включая равные свечи)
      flag: close > open ? 'green' : 'red',
      change: open ? Math.round(((close - open) / open) * 10000) / 100 : 0,
      close,
      value
    });
  }
  // Сначала самые волатильные — их интереснее смотреть
  out.sort((a, b) => b.atr - a.atr);
  return out;
}

/** Дневная история по одному тикеру. */
export async function fetchCandles(secid, from, till, fetchFn = fetch) {
  const cols = 'TRADEDATE,OPEN,LOW,HIGH,CLOSE,VOLUME';
  const j = await getJson(
    `${ISS}/history/engines/${BOARD}/securities/${secid}.json?from=${from}&till=${till}` +
      `&iss.meta=off&iss.only=history&history.columns=${cols}`
  );
  if (!j.history || !j.history.data) return [];
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

/** Дата N торговых дней назад от tradedate (грубая оценка через календарь). */
export function shiftDate(dateStr, days) {
  const d = new Date(dateStr.replace(/-/g, '/'));
  d.setDate(d.getDate() - days);
  return iso(d);
}

/** Полный прогон: отбор + история для графика. */
export async function run(opts = {}, fetchFn = fetch) {
  const o = { ...DEFAULTS, ...opts };
  const date = await findLastTradingDate(fetchFn);
  const rows = await fetchDayRows(date, fetchFn);
  const steps = await fetchSteps(fetchFn);
  const picked = select(rows, steps, o);
  const from = shiftDate(date, Math.ceil(o.historyDays * 1.6));
  const candles = {};
  for (const p of picked) {
    try {
      candles[p.secid] = await fetchCandles(p.secid, from, date, fetchFn);
    } catch {
      candles[p.secid] = [];
    }
  }
  return {
    tradedate: date,
    generated: new Date().toISOString(),
    params: { minValue: o.minValue, minAtr: o.minAtr, historyDays: o.historyDays },
    counts: { total: rows.length, picked: picked.length },
    watchlist: picked,
    candles
  };
}
