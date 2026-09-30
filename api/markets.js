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
      ticker: m.ticker,
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
    const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
    const ids = parse(m.clobTokenIds), outs = parse(m.outcomes);
    const yi = Array.isArray(outs) ? Math.max(0, outs.indexOf('Yes')) : 0;
    return {
      name: m.groupItemTitle || m.question,
      token: Array.isArray(ids) ? ids[yi] : null,
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


// ---- Livros de ordens: devolvem níveis [preço, quantidade] de COMPRA, do mais barato ao mais caro ----
const levels = (arr) => (arr || []).map((l) => {
  const raw = Array.isArray(l) ? l : [l.price, l.size];
  let p = num(raw[0]); const q = num(raw[1]);
  if (p !== null && p >= 1) p = p / 100; // Kalshi antiga usa centavos
  return [p, q];
}).filter(([p, q]) => valid(p) && q > 0);
const asc = (a) => a.sort((x, y) => x[0] - y[0]);
const flip = (a) => a.map(([p, q]) => [1 - p, q]);

async function kalshiBook(ticker) {
  const d = await getJson(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`);
  const ob = d.orderbook_fp || d.orderbook || {};
  const yesBids = levels(ob.yes_dollars || ob.yes), noBids = levels(ob.no_dollars || ob.no);
  // quem oferece Não a X aceita vender Sim a 1-X, e vice-versa
  return { buyYes: asc(flip(noBids)), buyNo: asc(flip(yesBids)) };
}

async function polyBook(token) {
  if (!token) throw new Error('sem token do mercado');
  const d = await getJson(`https://clob.polymarket.com/book?token_id=${token}`);
  return { buyYes: asc(levels(d.asks)), buyNo: asc(flip(levels(d.bids))) };
}

// Compra Sim e Não em paralelo, nível a nível, enquanto ainda sobrar lucro depois das taxas.
function walk(yes, no, feeY, feeN) {
  let i = 0, j = 0, ry = yes[0] ? yes[0][1] : 0, rn = no[0] ? no[0][1] : 0;
  let contracts = 0, profit = 0, cost = 0;
  while (i < yes.length && j < no.length) {
    const py = yes[i][0], pn = no[j][0];
    const net = 1 - py - pn - feeY(py) - feeN(pn);
    if (net <= 1e-6) break;
    const q = Math.min(ry, rn);
    contracts += q; profit += q * net; cost += q * (py + pn + feeY(py) + feeN(pn));
    ry -= q; rn -= q;
    if (ry <= 1e-9) { i++; ry = yes[i] ? yes[i][1] : 0; }
    if (rn <= 1e-9) { j++; rn = no[j] ? no[j][1] : 0; }
  }
  return { contracts, profit, cost };
}

// Gasta um orçamento (US$) comprando Sim e Não em paralelo, mesmo que o lucro seja negativo, para mostrar o resultado real.
function walkBudget(yes, no, feeY, feeN, budget) {
  let i = 0, j = 0, ry = yes[0][1], rn = no[0][1], left = budget, contracts = 0, cost = 0;
  while (i < yes.length && j < no.length && left > 1e-6) {
    const py = yes[i][0], pn = no[j][0];
    const c = py + pn + feeY(py) + feeN(pn);
    const q = Math.min(ry, rn, left / c);
    if (q <= 1e-9) break;
    contracts += q; cost += q * c; left -= q * c; ry -= q; rn -= q;
    if (ry <= 1e-9) { i++; ry = yes[i] ? yes[i][1] : 0; }
    if (rn <= 1e-9) { j++; rn = no[j] ? no[j][1] : 0; }
  }
  return { contracts, cost, profit: contracts - cost, unspent: left };
}

module.exports = async function handler(req, res) {
  const budget = Math.min(Math.max(num(req.query && req.query.budget) || 0, 0), 1e7);
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

  // Profundidade: só para os candidatos próximos de ter spread (limita chamadas)
  const fee = (on) => (on === 'Kalshi' ? kalshiFee : polyFee);
  await Promise.all(rows.filter((r) => r.best && r.best.gross > -0.03).slice(0, 4).map(async (r) => {
    const [kb, pb] = await Promise.allSettled([kalshiBook(r.kalshi.ticker), polyBook(r.poly.token)]);
    if (kb.status !== 'fulfilled' || pb.status !== 'fAulfilled') {
      r.best.depthError = true;
      if (kb.status === 'rejected') errors.push(`Livro Kalshi (${r.name}): ${kb.reason.message}`);
      if (pb.status === 'rejected') errors.push(`Livro Polymarket (${r.name}): ${pb.reason.message}`);
      return;
    }
    const b = r.best;
    const yes = b.buyYesOn === 'Kalshi' ? kb.value.buyYes : pb.value.buyYes;
    const no = b.buyNoOn === 'Kalshi' ? kb.value.buyNo : pb.value.buyNo;
    if (!yes.length || !no.length) {
      b.depthError = true;
      errors.push(`Livro vazio ou em formato inesperado (${r.name}): Sim na ${b.buyYesOn} com ${yes.length} níveis, Não na ${b.buyNoOn} com ${no.length} níveis`);
      return;
    }
    b.depth = { ...walk(yes, no, fee(b.buyYesOn), fee(b.buyNoOn)), topYes: yes[0][0], topNo: no[0][0] };
    if (budget > 0) b.budgetRun = walkBudget(yes, no, fee(b.buyYesOn), fee(b.buyNoOn), budget);
  }));

  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    links: { kalshi: KALSHI_URL, poly: POLY_URL },
    budget, errors, rows, unmatchedPoly,
    feeNote: `Kalshi ${KALSHI_FEE_RATE} x p x (1-p); Polymarket ${POLY_FEE_RATE}`,
  });
};
