const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');
const jupiterMarket = require('./jupiterMarket');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCfg() {
  const pm = config.priceMonitoring || {};
  return {
    timeoutMs: Math.max(300, n(pm.timeoutMs, 3000)),
    observationIntervalMs: Math.max(250, n(pm.observationIntervalMs, 750)),
    activeIntervalMs: Math.max(250, n(pm.activeIntervalMs, 750)),
    maxImpact: Math.max(0, n(pm.maxJupiterPriceImpactPct, 0.05)),
    rejectOnFail: pm.rejectIfJupiterPreEntryFails !== false
  };
}

function priceStats(prices) {
  const startPrice = prices[0];
  const endPrice = prices[prices.length - 1];
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const momentumPercent = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
  const maxDropPercent = maxPrice > 0 ? ((maxPrice - minPrice) / maxPrice) * 100 : 0;
  const pullbackFromPeakPercent = maxPrice > 0 ? ((maxPrice - endPrice) / maxPrice) * 100 : 0;
  const changes = [];
  for (let i = 1; i < prices.length; i++) changes.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  const mean = changes.reduce((a, b) => a + b, 0) / Math.max(changes.length, 1);
  const volatility = Math.sqrt(changes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(changes.length, 1));
  return { startPrice, endPrice, minPrice, maxPrice, momentumPercent, maxDropPercent, pullbackFromPeakPercent, volatility };
}

function rejectObservation(token, reason, extra = {}) {
  activityLogger.log('JUPITER_OBSERVATION_REJECTED', {
    symbol: token.baseToken?.symbol,
    address: token.baseToken?.address,
    reason,
    ...extra
  });
  console.log(`\n[Observer] ❌ ${token.baseToken?.symbol} ditolak: ${reason}`);
  return false;
}

function applyJupiterFullPricePatch(engine) {
  if (!engine || engine.__jupiterFullPricePatchApplied) return engine;

  if (engine.connection) jupiterMarket.bindConnection(engine.connection);

  engine.getActivePositionPrice = async function getActivePositionPriceViaJupiter(timeoutMs = null) {
    try {
      const position = this.currentPosition;
      const tokenUnits = n(position?.receivedTokenUnits, 0);
      if (!position?.address || tokenUnits <= 0) return { price: null, source: 'jupiter_miss' };

      const quote = await jupiterMarket.getSellQuote(position.address, tokenUnits, timeoutMs || getCfg().timeoutMs);
      if (!quote) return { price: null, source: 'jupiter_miss' };

      position.lastJupiterQuoteAt = new Date().toISOString();
      position.lastJupiterOutSol = quote.outSol;
      position.lastJupiterPriceUsd = quote.impliedPriceUsd;
      position.lastJupiterPriceImpactPct = quote.priceImpactPct;
      return { price: quote.impliedPriceUsd, source: 'jupiter' };
    } catch (error) {
      activityLogger.log('JUPITER_POSITION_PRICE_ERROR', {
        symbol: this.currentPosition?.symbol,
        address: this.currentPosition?.address,
        error: error.response?.data?.error || error.message
      });
      return { price: null, source: 'jupiter_miss' };
    }
  };

  const originalObserveAndConfirm = engine.observeAndConfirm?.bind(engine);
  engine.observeAndConfirm = async function observeAndConfirmViaJupiter(token) {
    const cfg = getCfg();
    const obs = config.observation || {};
    const ar = this.getAdaptiveRiskConfig();
    const size = typeof this.calculateAdaptivePositionSize === 'function'
      ? this.calculateAdaptivePositionSize(token).size
      : n(config.trading?.positionSize, 0.2);

    activityLogger.log('OBSERVATION_START', { symbol: token.baseToken?.symbol, source: 'jupiter' });
    console.log(`\n[Observer] Mengawasi ${token.baseToken?.symbol} via Jupiter quote selama ${obs.durationSeconds} detik...`);

    if (this.getPriceMonitoringConfig().validateOnChainOnce && !(await this.validateTokenOnChain(token.baseToken.address))) {
      return rejectObservation(token, 'token account tidak valid on-chain');
    }

    const prices = [];
    const quotes = [];
    const startedAt = Date.now();
    const durationMs = n(obs.durationSeconds, 10) * 1000;

    while (Date.now() - startedAt < durationMs) {
      try {
        const quote = await jupiterMarket.getProbePrice(token.baseToken.address, size, cfg.timeoutMs);
        if (quote?.impliedPriceUsd > 0) {
          prices.push(quote.impliedPriceUsd);
          quotes.push(quote);
        }
      } catch (error) {
        activityLogger.log('JUPITER_OBSERVATION_TICK_ERROR', {
          symbol: token.baseToken?.symbol,
          address: token.baseToken?.address,
          error: error.response?.data?.error || error.message
        });
      }
      await sleep(cfg.observationIntervalMs);
    }

    if (prices.length < 3) {
      if (cfg.rejectOnFail) return rejectObservation(token, 'quote Jupiter kurang dari 3 tick', { ticks: prices.length });
      return originalObserveAndConfirm(token);
    }

    const minUniquePrices = Math.max(1, n(obs.minUniquePrices, 3));
    const uniquePrices = new Set(prices.map(price => Number(price).toPrecision(12))).size;
    if (uniquePrices < minUniquePrices) {
      return rejectObservation(token, `unique price kurang (${uniquePrices}/${minUniquePrices})`, { uniquePrices, minUniquePrices });
    }

    if (obs.rejectZeroMovement !== false && uniquePrices <= 1) {
      return rejectObservation(token, 'zero movement / harga flat', { uniquePrices });
    }

    const stats = priceStats(prices);
    const minMomentumPercent = n(obs.minMomentumPercent, 0.5);
    const flatObservation = this.isFlatObservation(uniquePrices);

    if (stats.momentumPercent < minMomentumPercent) {
      return rejectObservation(token, `momentum kurang (${stats.momentumPercent.toFixed(2)}% < ${minMomentumPercent}%)`, stats);
    }
    if (stats.momentumPercent < -3) return rejectObservation(token, 'momentum negatif lebih dari 3%', stats);
    if (stats.maxDropPercent > n(obs.maxDumpPercent, 22)) return rejectObservation(token, 'max dump terlalu besar', stats);
    if (stats.pullbackFromPeakPercent > n(obs.maxFromPeakPercent, 10)) return rejectObservation(token, 'pullback dari peak terlalu besar', stats);
    if (!flatObservation && stats.volatility > ar.maxAllowedVolatility) return rejectObservation(token, 'volatilitas terlalu tinggi', { ...stats, maxAllowedVolatility: ar.maxAllowedVolatility });

    const lastQuote = quotes[quotes.length - 1];
    const impact = Math.abs(n(lastQuote?.priceImpactPct, 0));
    if (impact > cfg.maxImpact) return rejectObservation(token, 'price impact Jupiter terlalu besar', { impact, maxImpact: cfg.maxImpact });

    Object.assign(token, {
      volatility: stats.volatility,
      priceRange: stats.maxDropPercent,
      confirmedEntryPrice: stats.endPrice,
      observedStartPrice: stats.startPrice,
      observedMaxPrice: stats.maxPrice,
      observedMinPrice: stats.minPrice,
      uniquePrices,
      flatObservation,
      jupiterEntryQuote: lastQuote,
      jupiterObservedPrices: prices,
      jupiterMomentumPercent: stats.momentumPercent,
      jupiterPullbackFromPeakPercent: stats.pullbackFromPeakPercent
    });

    console.log(`\n[Observer] ✅ Jupiter confirmed. Momentum ${stats.momentumPercent.toFixed(2)}%, unique prices ${uniquePrices}.`);
    return true;
  };

  const originalOpenPosition = engine.openPosition?.bind(engine);
  engine.openPosition = async function openPositionWithFreshJupiterEntry(token) {
    const cfg = getCfg();
    const size = typeof this.calculateAdaptivePositionSize === 'function'
      ? this.calculateAdaptivePositionSize(token).size
      : n(config.trading?.positionSize, 0.2);

    try {
      const quote = await jupiterMarket.getProbePrice(token.baseToken.address, size, cfg.timeoutMs);
      if (!quote?.impliedPriceUsd) {
        activityLogger.log('JUPITER_ENTRY_REJECTED', { symbol: token.baseToken?.symbol, address: token.baseToken?.address, reason: 'missing_quote' });
        if (cfg.rejectOnFail) return;
      } else {
        token.confirmedEntryPrice = quote.impliedPriceUsd;
        token.jupiterEntryQuote = quote;
      }
    } catch (error) {
      activityLogger.log('JUPITER_ENTRY_ERROR', { symbol: token.baseToken?.symbol, address: token.baseToken?.address, error: error.response?.data?.error || error.message });
      if (cfg.rejectOnFail) return;
    }

    return originalOpenPosition(token);
  };

  engine.__jupiterFullPricePatchApplied = true;
  return engine;
}

module.exports = applyJupiterFullPricePatch;
