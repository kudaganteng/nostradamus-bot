const axios = require('axios');
const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getHeaders() {
  const headers = { Accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  return headers;
}

function getCfg() {
  const pm = config.priceMonitoring || {};
  return {
    enabled: pm.useJupiterPreEntryValidation === true,
    rejectOnFail: pm.rejectIfJupiterPreEntryFails !== false,
    url: pm.jupiterQuoteUrl || 'https://api.jup.ag/swap/v1/quote',
    slippageBps: Math.max(1, n(pm.jupiterSlippageBps, 100)),
    onlyDirectRoutes: pm.jupiterOnlyDirectRoutes === true,
    assumedSolUsd: Math.max(1, n(pm.assumedSolUsd, 150)),
    maxDivergence: Math.max(0, n(pm.maxPreEntryJupiterDexDivergencePercent, 20)),
    maxImpact: Math.max(0, n(pm.maxPreEntryPriceImpactPct, 0.03)),
    attempts: Math.max(1, n(pm.preEntryQuoteAttempts, 2)),
    timeoutMs: Math.max(300, n(pm.timeoutMs, 3000))
  };
}

async function getBuyQuote(token, sizeSol, cfg) {
  const amount = Math.floor(sizeSol * Math.pow(10, SOL_DECIMALS));
  const response = await axios.get(cfg.url, {
    params: {
      inputMint: SOL_MINT,
      outputMint: token.baseToken.address,
      amount: String(amount),
      slippageBps: String(cfg.slippageBps),
      onlyDirectRoutes: String(cfg.onlyDirectRoutes)
    },
    headers: getHeaders(),
    timeout: cfg.timeoutMs
  });

  const outRaw = n(response.data?.outAmount, 0);
  const decimals = Number.isFinite(Number(token.baseToken?.decimals)) ? Number(token.baseToken.decimals) : 6;
  const tokenUnits = outRaw / Math.pow(10, decimals);
  const impliedPriceUsd = tokenUnits > 0 ? (sizeSol * cfg.assumedSolUsd) / tokenUnits : 0;

  return {
    impliedPriceUsd,
    tokenUnits,
    outRaw,
    priceImpactPct: n(response.data?.priceImpactPct, 0),
    raw: response.data
  };
}

function validate({ token, dexPrice, quote, cfg, sizeSol }) {
  if (!quote || !quote.impliedPriceUsd) return { ok: false, reason: 'missing_quote' };
  const divergence = Math.abs((quote.impliedPriceUsd - dexPrice) / dexPrice) * 100;
  const impact = Math.abs(n(quote.priceImpactPct, 0));

  if (divergence > cfg.maxDivergence) {
    return { ok: false, reason: `divergence ${divergence.toFixed(2)}%`, divergence, impact };
  }
  if (impact > cfg.maxImpact) {
    return { ok: false, reason: `impact ${(impact * 100).toFixed(2)}%`, divergence, impact };
  }
  return {
    ok: true,
    reason: `ok divergence ${divergence.toFixed(2)}% impact ${(impact * 100).toFixed(2)}%`,
    divergence,
    impact,
    dexPrice,
    jupiterPrice: quote.impliedPriceUsd,
    sizeSol,
    symbol: token.baseToken?.symbol
  };
}

function applyPreEntryQuotePatch(engine) {
  if (!engine || engine.__preEntryQuotePatchApplied) return engine;
  const originalOpenPosition = engine.openPosition?.bind(engine);

  engine.openPosition = async function patchedOpenPosition(token) {
    const cfg = getCfg();
    if (!cfg.enabled) return originalOpenPosition(token);

    const dexPrice = n(token.confirmedEntryPrice || token.priceUsd, 0);
    if (!dexPrice) {
      activityLogger.log('JUPITER_PRE_ENTRY_REJECTED', { symbol: token.baseToken?.symbol, reason: 'missing_dex_price' });
      if (cfg.rejectOnFail) return;
      return originalOpenPosition(token);
    }

    const sizeSol = typeof this.calculateAdaptivePositionSize === 'function'
      ? this.calculateAdaptivePositionSize(token).size
      : n(config.trading?.positionSize, 0.2);

    let last = { ok: false, reason: 'not_checked' };
    for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
      try {
        const quote = await getBuyQuote(token, sizeSol, cfg);
        last = validate({ token, dexPrice, quote, cfg, sizeSol });
        token.jupiterPreEntry = { ...last, quote };

        activityLogger.log(last.ok ? 'JUPITER_PRE_ENTRY_OK' : 'JUPITER_PRE_ENTRY_REJECTED', {
          symbol: token.baseToken?.symbol,
          address: token.baseToken?.address,
          attempt,
          reason: last.reason,
          dexPrice,
          jupiterPrice: quote.impliedPriceUsd,
          priceImpactPct: quote.priceImpactPct,
          sizeSol
        });

        if (last.ok) break;
      } catch (error) {
        last = { ok: false, reason: error.response?.data?.error || error.message };
        activityLogger.log('JUPITER_PRE_ENTRY_ERROR', {
          symbol: token.baseToken?.symbol,
          address: token.baseToken?.address,
          attempt,
          reason: last.reason,
          sizeSol
        });
      }
    }

    if (!last.ok && cfg.rejectOnFail) {
      console.log(`\n[PRE-ENTRY] ❌ Entry ditolak: ${last.reason}`);
      return;
    }
    if (last.ok) console.log(`\n[PRE-ENTRY] ✅ Jupiter buy quote valid: ${last.reason}`);
    return originalOpenPosition(token);
  };

  engine.__preEntryQuotePatchApplied = true;
  return engine;
}

module.exports = applyPreEntryQuotePatch;
