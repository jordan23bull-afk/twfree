/**
 * Отбор акций MOEX, площадка TQBR.
 * Работает только в Node: запускается из screener.mjs, на выходе data.json,
 * который читает rosn.html. В браузере отбора нет намеренно — единственный
 * источник данных для страницы это готовый файл.
 */

const ISS = 'https://iss.moex.com/iss';
const BOARD = 'stock/markets/shares/boards/TQBR';
const HISTORY_ALL = `${ISS}/history/engines/${BOARD}/securities.json`;
const BOARD_SECURITIES = `${ISS}/engines/${BOARD}/securities.json`;

// Пороги отбора
export const DEFAULTS = {
  minValue: 10_000_000, // минимальный оборот за день, руб.
  minAtr: 150, // минимальный ATR в шагах цены
  historyDays: 30, // сколько дней истории класть в файл
  maxLookback: 10 // сколько дней назад искать последнюю торговую сессию
};

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
export async function findLastTradingDate(maxLookback = DEFAULTS.maxLookback) {
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
export async function fetchDayRows(date) {
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

/** Шаг цены (MINSTEP) для всех тикеров: у каждой бумаги он свой. */
export async function fetchSteps() {
  const j = await getJson(
    `${BOARD_SECURITIES}?iss.meta=off&iss.only=securities&securities.columns=SECID,MINSTEP`
  );
  const steps = {};
  for (const row of j.securities.data) steps[row[0]] = Number(row[1]);
  return steps;
}

/**
 * Отбор: оборот и объём -> ATR в шагах цены -> цвет флага.
 * ATR = (HIGH - LOW) / MINSTEP, то есть в пунктах, а не в рублях.
 */
export function select(rows, steps, opts = {}) {
  const { minValue, minAtr } = { ...DEFAULTS, ...opts };
  const out = [];
  for (const r of rows) {
    if (!(Number(r.VALUE) >= minValue) || !(Number(r.VOLUME) > 0)) continue;
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
      value: Number(r.VALUE)
    });
  }
  // Сначала самые волатильные — их интереснее смотреть
  out.sort((a, b) => b.atr - a.atr);
  return out;
}

/** Дневная история по одному тикеру. */
export async function fetchCandles(secid, from, till) {
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

/** Полный прогон: отбор + история для графика. */
export async function run(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const date = await findLastTradingDate();
  const rows = await fetchDayRows(date);
  const steps = await fetchSteps();
  const picked = select(rows, steps, o);
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
    params: { minValue: o.minValue, minAtr: o.minAtr, historyDays: o.historyDays },
    counts: { total: rows.length, picked: picked.length },
    watchlist: picked,
    candles
  };
}
