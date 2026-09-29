/**
 * Запуск отбора и запись data.json.
 *   node screener.mjs
 *   node screener.mjs --value 5000000 --atr 100 --days 60
 */
import { writeFile } from 'node:fs/promises';
import { run, DEFAULTS } from './screener-core.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const opts = {
  minValue: arg('value', DEFAULTS.minValue),
  minAtr: arg('atr', DEFAULTS.minAtr),
  historyDays: arg('days', DEFAULTS.historyDays)
};

const log = (...a) => console.log(...a);

log('Отбор акций MOEX, TQBR');
log(`  оборот от ${opts.minValue.toLocaleString('ru')} руб.`);
log(`  ATR от ${opts.minAtr} пунктов`);
log(`  история ${opts.historyDays} торговых дней`);
log('');

try {
  const data = await run(opts);
  const json = JSON.stringify(data);
  await writeFile(new URL('./data.json', import.meta.url), json, 'utf8');

  log(`Торговая сессия: ${data.tradedate}`);
  log(`Акций в отборе: ${data.counts.picked} из ${data.counts.total}`);
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
