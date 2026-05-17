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
  const maxDropPercent = ((maxPrice - minPrice) / maxPrice) * 100;
  const changes = [];
  for (let i = 1; i < prices.length; i++) changes.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  const mean = changes.reduce((a, b) => a + b, 0) / Math.max(changes.length, 1);
  const volatility = Math.sqrt(changes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(changes.length, 1));
  return { startPrice, endPrice, minPrice, maxPrice, maxDropPercent, volatility };
}

function patchOpenPositionResult(engine) {
  if (!engine || engine.__openPositionResultPatchApplied) return;

  const originalOpenPosition = engine.openPosition?.bind(engine);
  engine.openPosition = async function openPositionWithResult(token) {
    if (this.currentPosition) {
      return { ok: false, reason: 'Sudah ada posisi aktif' };
    }

    const before = this.currentPosition;
    const result = await originalOpenPosition(token);

    if (this.currentPosition && this.currentPosition !== before) {
      return { ok: true, position: this.currentPosition, result };
    }

    return { ok: false, reason: 'Engine gagal membuka posisi. Kemungkinan fresh quote Jupiter gagal, confirmedEntryPrice invalid, history guard, atau simulated BUY failed.' };
  };

  engine.__openPositionResultPatchApplied = true;
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

    if (this.getPriceMonitoringConfig().validateOnChainOnce && !(await this.validateTokenOnChain(token.baseToken.address))) return false;

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
      if (cfg.rejectOnFail) return false;
      return originalObserveAndConfirm(token);
    }

    const uniquePrices = new Set(prices.map(price => Number(price).toPrecision(12))).size;
    if (uniquePrices < n(obs.minUniquePrices, 1)) return false;

    const stats = priceStats(prices);
    const flatObservation = this.isFlatObservation(uniquePrices);
    if (((stats.endPrice - stats.startPrice) / stats.startPrice) * 100 < -3) return false;
    if (stats.maxDropPercent > n(obs.maxDumpPercent, 22)) return false;
    if (((stats.maxPrice - stats.endPrice) / stats.maxPrice) * 100 > n(obs.maxFromPeakPercent, 10)) return false;
    if (!flatObservation && stats.volatility > ar.maxAllowedVolatility) return false;

    const lastQuote = quotes[quotes.length - 1];
    if (Math.abs(n(lastQuote?.priceImpactPct, 0)) > cfg.maxImpact) return false;

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
      jupiterObservedPrices: prices
    });

    console.log('\n[Observer] Jupiter confirmed. Entry price sekarang pakai quote Jupiter.');
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
        const reason = 'fresh Jupiter entry quote kosong';
        console.log(`\n[ENTRY SKIPPED] ${token.baseToken?.symbol}: ${reason}`);
        activityLogger.log('JUPITER_ENTRY_REJECTED', { symbol: token.baseToken?.symbol, address: token.baseToken?.address, reason });
        if (cfg.rejectOnFail) return { ok: false, reason };
      } else {
        token.confirmedEntryPrice = quote.impliedPriceUsd;
        token.jupiterEntryQuote = quote;
      }
    } catch (error) {
      const reason = error.response?.data?.error || error.message;
      console.log(`\n[ENTRY SKIPPED] ${token.baseToken?.symbol}: fresh Jupiter entry quote error - ${reason}`);
      activityLogger.log('JUPITER_ENTRY_ERROR', { symbol: token.baseToken?.symbol, address: token.baseToken?.address, error: reason });
      if (cfg.rejectOnFail) return { ok: false, reason: `Jupiter entry error: ${reason}` };
    }

    const before = this.currentPosition;
    const result = await originalOpenPosition(token);
    if (this.currentPosition && this.currentPosition !== before) {
      return { ok: true, position: this.currentPosition, result };
    }

    const reason = 'original engine.openPosition tidak membuat posisi aktif';
    console.log(`\n[ENTRY SKIPPED] ${token.baseToken?.symbol}: ${reason}`);
    activityLogger.log('ENGINE_OPEN_POSITION_FAILED', { symbol: token.baseToken?.symbol, address: token.baseToken?.address, reason });
    return { ok: false, reason };
  };

  patchOpenPositionResult(engine);
  engine.__jupiterFullPricePatchApplied = true;
  return engine;
}

module.exports = applyJupiterFullPricePatch;
