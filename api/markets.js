// Função servidora da Vercel: busca Kalshi + Polymarket, casa candidatos e calcula o spread.

const KALSHI_EVENT = 'KXBRPRES-26';
const POLY_SLUG = 'brazil-presidential-election';
const KALSHI_URL = 'https://kalshi.com/markets/kxbrpres/brazil-presidency/kxbrpres-26';
const POLY_URL = 'https://polymarket.com/event/brazil-presidential-election';

// Taxas (AJUSTE AQUI se mudarem). Kalshi: 0,07 x preço x (1 - preço) por contrato, arredondado para cima.
const KALSHI_FEE_RATE = 0.07;
const POLY_FEE_RATE = 0; // confirme na Polymarket; aqui assumido como zero

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const tokens = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const sameName = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  const [s, l] = A.length <= B.length ? [A, B] : [B, A];
  return s.every((t) => l.includes(t));
};
const kalshiFee = (p) => Math.ceil(KALSHI_FEE_RATE * p * (1 - p) * 100 - 1e-9) / 100;
const polyFee = (p) => POLY_FEE_RATE * p * (1 - p);
const valid = (p) => p !== null && p > 0 && p < 1;

// Kalshi devolve centavos (yes_ask) ou dólares (yes_ask_dollars), dependendo da versão da API.
const price = (m, f) => (m[f + '_dollars'] != null ? num(m[f + '_dollars']) : m[f] != null ? num(m[f]) / 100 : null);

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).host}`);
  return r.json();
}

async function loadKalshi() {
  const d = await getJson(`https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${KALSHI_EVENT}&limit=100`);
  return (d.markets || []).map((m) => {
    const yesBid = price(m, 'yes_bid');
    const noAsk = price(m, 'no_ask');
    return {
      name: m.yes_sub_title || m.subtitle || m.title,
      yes: price(m, 'yes_ask'),
      no: noAsk !== null ? noAsk : yesBid !== null ? 1 - yesBid : null,
      volume: num(m.volume_fp ?? m.volume),
    };
  });
}

async function loadPoly() {
  const d = await getJson(`https://gamma-api.polymarket.com/events?slug=${POLY_SLUG}`);
  const ev = Array.isArray(d) ? d[0] : d;
  if (!ev) throw new Error('Evento não encontrado na Polymarket');
  return (ev.markets || []).filter((m) => !m.closed).map((m) => {
    const bid = num(m.bestBid), ask = num(m.bestAsk);
    return {
      name: m.groupItemTitle || m.question,
      yes: ask,
      no: bid !== null ? 1 - bid : null,
      volume: num(m.volume),
    };
  });
}

function evaluate(k, p) {
  const options = [
    { buyYesOn: 'Kalshi', buyNoOn: 'Polymarket', yes: k.yes, no: p.no, fees: (valid(k.yes) ? kalshiFee(k.yes) : 0) + (valid(p.no) ? polyFee(p.no) : 0) },
    { buyYesOn: 'Polymarket', buyNoOn: 'Kalshi', yes: p.yes, no: k.no, fees: (valid(p.yes) ? polyFee(p.yes) : 0) + (valid(k.no) ? kalshiFee(k.no) : 0) },
  ].filter((o) => valid(o.yes) && valid(o.no))
   .map((o) => ({ ...o, cost: o.yes + o.no, gross: 1 - (o.yes + o.no), net: 1 - (o.yes + o.no) - o.fees }));
  return options.sort((a, b) => b.net - a.net)[0] || null;
}

module.exports = async function handler(req, res) {
  const [k, p] = await Promise.allSettled([loadKalshi(), loadPoly()]);
  const errors = [];
  if (k.status === 'rejected') errors.push('Kalshi: ' + k.reason.message);
  if (p.status === 'rejected') errors.push('Polymarket: ' + p.reason.message);

  const rows = [];
  let unmatchedPoly = [];
  if (k.status === 'fulfilled' && p.status === 'fulfilled') {
    const usedK = new Set();
    for (const pm of p.value) {
      const km = k.value.find((x) => sameName(x.name, pm.name));
      if (!km) { unmatchedPoly.push(pm.name); continue; }
      usedK.add(km);
      rows.push({ name: pm.name, kalshiName: km.name, kalshi: km, poly: pm, best: evaluate(km, pm) });
    }
    rows.sort((a, b) => (b.best ? b.best.net : -9) - (a.best ? a.best.net : -9));
  }

  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    links: { kalshi: KALSHI_URL, poly: POLY_URL },
    errors, rows, unmatchedPoly,
    feeNote: `Kalshi ${KALSHI_FEE_RATE} x p x (1-p); Polymarket ${POLY_FEE_RATE}`,
  });
};
