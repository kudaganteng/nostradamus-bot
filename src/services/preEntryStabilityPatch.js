const chalk = require('chalk');
const config = require('../../config.json');
const jupiter = require('./jupiter');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getLocalHour() {
  const t = config.timeRisk || {};
  const offsetHours = n(t.timezoneOffsetHours, 7);
  const now = new Date();
  return (now.getUTCHours() + offsetHours + 24) % 24;
}

function getTimeRiskMode() {
  const t = config.timeRisk || {};
  if (t.enabled !== true) return { name: 'off', skipEntry: false, positionSizeMultiplier: 1 };
  const hour = getLocalHour();
  const modes = ['normal', 'defensive', 'skip'];
  for (const name of modes) {
    const mode = t[name] || {};
    if (Array.isArray(mode.hours) && mode.hours.includes(hour)) return { name, hour, ...mode };
  }
  const defaultName = t.defaultMode || 'skip';
  return { name: defaultName, hour, ...(t[defaultName] || { skipEntry: true }) };
}

function getPreEntryConfig(timeMode = null) {
  const p = config.preEntryStability || {};
  return {
    enabled: p.enabled === true,
    delayMs: Math.max(0, n(p.delayMs, 2500)),
    maxBuyQuoteWorseningPct: n(timeMode?.maxBuyQuoteWorseningPct, n(p.maxBuyQuoteWorseningPct, 1.5)),
    maxRoundTripLossWorseningPct: n(timeMode?.maxRoundTripLossWorseningPct, n(p.maxRoundTripLossWorseningPct, 0.75)),
    rejectIfSecondQuoteFails: p.rejectIfSecondQuoteFails !== false,
    rejectIfPositionSizeDrops: p.rejectIfPositionSizeDrops === true,
    positionSizeMultiplier: n(timeMode?.positionSizeMultiplier, 1)
  };
}

function getJupiterObserverConfig() {
  const j = config.jupiterObserver || {};
  return {
    enabled: j.enabled === true,
    samples: Math.max(2, n(j.samples, 3)),
    intervalMs: Math.max(500, n(j.intervalMs, 2000)),
    maxExitSolDropPct: n(j.maxExitSolDropPct, 1.2),
    maxRoundTripLossIncreasePct: n(j.maxRoundTripLossIncreasePct, 0.5),
    maxSellImpactPct: n(j.maxSellImpactPct, 0.03),
    rejectIfAllExitSolTicksDown: j.rejectIfAllExitSolTicksDown !== false,
    flatDexTighten: j.flatDexTighten === true,
    flatDexMaxExitSolDropPct: n(j.flatDexMaxExitSolDropPct, 0.8),
    flatDexMaxSellImpactPct: n(j.flatDexMaxSellImpactPct, 0.028)
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buyQuoteWorseningPct(first, second) {
  if (!first?.entryPriceUsd || !second?.entryPriceUsd) return 0;
  return ((second.entryPriceUsd - first.entryPriceUsd) / first.entryPriceUsd) * 100;
}

function roundTripWorseningPct(first, second) {
  const a = n(first?.roundTrip?.roundTripLossPct, 0);
  const b = n(second?.roundTrip?.roundTripLossPct, 0);
  return b - a;
}

function positionSizeDropped(first, second) {
  return n(second?.executedPositionSizeSol, 0) < n(first?.executedPositionSizeSol, 0);
}

function isDexObserverFlat(token) {
  const trend = Math.abs(n(token.observedTrendPercent, 0));
  const volatility = Math.abs(n(token.volatility, 0));
  const start = n(token.observedStartPrice, 0);
  const end = n(token.observedEndPrice, 0);
  const max = n(token.observedMaxPrice, 0);
  const min = n(token.observedMinPrice, 0);
  return trend === 0 && volatility === 0 && start === end && max === min;
}

function summarizeObserverSamples(samples) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const exitSolStart = n(first?.roundTrip?.roundTripOutSol, 0);
  const exitSolEnd = n(last?.roundTrip?.roundTripOutSol, 0);
  const exitSolDropPct = exitSolStart > 0 ? ((exitSolStart - exitSolEnd) / exitSolStart) * 100 : 0;
  const roundTripLossStart = n(first?.roundTrip?.roundTripLossPct, 0);
  const roundTripLossEnd = n(last?.roundTrip?.roundTripLossPct, 0);
  const roundTripLossIncreasePct = roundTripLossEnd - roundTripLossStart;
  const sellImpacts = samples.map(s => n(s?.roundTrip?.sellImpactPct, 0));
  const sellImpactMax = Math.max(...sellImpacts);
  const exitSolValues = samples.map(s => n(s?.roundTrip?.roundTripOutSol, 0));
  const allExitSolTicksDown = exitSolValues.length > 1 && exitSolValues.slice(1).every((value, i) => value < exitSolValues[i]);
  return { exitSolStart, exitSolEnd, exitSolDropPct, roundTripLossStart, roundTripLossEnd, roundTripLossIncreasePct, sellImpactMax, exitSolValues, allExitSolTicksDown };
}

function compactSample(sample, index) {
  return {
    index,
    positionSizeSol: sample.executedPositionSizeSol,
    entryPriceUsd: sample.entryPriceUsd,
    roundTripLossPct: sample.roundTrip?.roundTripLossPct,
    roundTripOutSol: sample.roundTrip?.roundTripOutSol,
    sellImpactPct: sample.roundTrip?.sellImpactPct,
    priceImpactPct: sample.priceImpactPct
  };
}

function evaluateJupiterObserver({ token, samples }) {
  const cfg = getJupiterObserverConfig();
  const summary = summarizeObserverSamples(samples);
  const flatDex = isDexObserverFlat(token);
  const maxExitSolDropPct = flatDex && cfg.flatDexTighten ? cfg.flatDexMaxExitSolDropPct : cfg.maxExitSolDropPct;
  const maxSellImpactPct = flatDex && cfg.flatDexTighten ? cfg.flatDexMaxSellImpactPct : cfg.maxSellImpactPct;

  const result = {
    accepted: true,
    flatDex,
    samples: samples.map(compactSample),
    ...summary,
    limits: {
      maxExitSolDropPct,
      maxRoundTripLossIncreasePct: cfg.maxRoundTripLossIncreasePct,
      maxSellImpactPct
    }
  };

  if (summary.exitSolDropPct > maxExitSolDropPct) {
    result.accepted = false;
    result.reason = `Jupiter observer exitSol drop ${summary.exitSolDropPct.toFixed(2)}% > ${maxExitSolDropPct}%${flatDex ? ' (flat Dex)' : ''}`;
  }

  if (result.accepted && summary.roundTripLossIncreasePct > cfg.maxRoundTripLossIncreasePct) {
    result.accepted = false;
    result.reason = `Jupiter observer round-trip loss memburuk ${summary.roundTripLossIncreasePct.toFixed(2)}% > ${cfg.maxRoundTripLossIncreasePct}%`;
  }

  if (result.accepted && summary.sellImpactMax > maxSellImpactPct) {
    result.accepted = false;
    result.reason = `Jupiter observer sell impact ${summary.sellImpactMax.toFixed(4)} > ${maxSellImpactPct}${flatDex ? ' (flat Dex)' : ''}`;
  }

  if (result.accepted && cfg.rejectIfAllExitSolTicksDown && summary.allExitSolTicksDown) {
    result.accepted = false;
    result.reason = 'Jupiter observer semua tick exitSol turun';
  }

  return result;
}

function applyPreEntryStabilityPatch(engine) {
  if (!engine || engine.__preEntryStabilityPatchApplied) return engine;

  engine.runJupiterObserver = async function runJupiterObserver(token, tokenDecimals, requestedSize) {
    const cfg = getJupiterObserverConfig();
    const symbol = token.baseToken.symbol;
    const mint = token.baseToken.address;
    if (!cfg.enabled) return { accepted: true, skipped: true };

    const samples = [];
    console.log(chalk.cyan(`[Jupiter Observer] ${symbol}: ${cfg.samples} sample setiap ${cfg.intervalMs / 1000}s...`));

    for (let i = 0; i < cfg.samples; i++) {
      try {
        const sample = await jupiter.getBuyExecution(mint, requestedSize, tokenDecimals);
        samples.push(sample);
        console.log(chalk.gray(`   #${i + 1} out ${sample.roundTrip?.roundTripOutSol?.toFixed?.(6)} SOL | rtLoss ${n(sample.roundTrip?.roundTripLossPct, 0).toFixed(2)}% | sellImpact ${n(sample.roundTrip?.sellImpactPct, 0).toFixed(4)}`));
      } catch (error) {
        activityLogger.log('JUPITER_OBSERVER_SAMPLE_FAILED', { symbol, address: mint, requestedSize, sampleIndex: i + 1, error: error.message });
        return { accepted: false, reason: `Jupiter observer sample ${i + 1} gagal: ${error.message}`, samples: samples.map(compactSample) };
      }
      if (i < cfg.samples - 1) await delay(cfg.intervalMs);
    }

    const result = evaluateJupiterObserver({ token, samples });
    activityLogger.log(result.accepted ? 'JUPITER_OBSERVER_ACCEPTED' : 'JUPITER_OBSERVER_REJECTED', {
      symbol,
      address: mint,
      requestedSize,
      accepted: result.accepted,
      reason: result.reason,
      flatDex: result.flatDex,
      exitSolDropPct: result.exitSolDropPct,
      roundTripLossIncreasePct: result.roundTripLossIncreasePct,
      sellImpactMax: result.sellImpactMax,
      allExitSolTicksDown: result.allExitSolTicksDown
    });
    return result;
  };

  engine.runPreEntryStabilityCheck = async function runPreEntryStabilityCheck(token, tokenDecimals) {
    const timeMode = getTimeRiskMode();
    if (timeMode.skipEntry === true) {
      activityLogger.log('TIME_RISK_ENTRY_SKIPPED', { symbol: token.baseToken.symbol, address: token.baseToken.address, mode: timeMode.name, hour: timeMode.hour });
      return { accepted: false, reason: `time risk mode ${timeMode.name} pada jam ${timeMode.hour}:00` };
    }

    const cfg = getPreEntryConfig(timeMode);
    if (!cfg.enabled) return { accepted: true, skipped: true, timeMode };

    const symbol = token.baseToken.symbol;
    const mint = token.baseToken.address;
    const requestedSize = Number((config.trading.positionSize * cfg.positionSizeMultiplier).toFixed(9));
    console.log(chalk.cyan(`\n[PreEntry Stability] ${symbol} | timeMode=${timeMode.name} | size=${requestedSize} SOL | jam=${timeMode.hour}:00`));

    let first;
    let second;

    try {
      first = await jupiter.getBuyExecution(mint, requestedSize, tokenDecimals);
    } catch (error) {
      activityLogger.log('PRE_ENTRY_STABILITY_FIRST_QUOTE_FAILED', { symbol, address: mint, error: error.message, timeMode: timeMode.name, requestedSize });
      return { accepted: false, reason: `quote pertama gagal: ${error.message}`, timeMode };
    }

    await delay(cfg.delayMs);

    try {
      second = await jupiter.getBuyExecution(mint, requestedSize, tokenDecimals);
    } catch (error) {
      activityLogger.log('PRE_ENTRY_STABILITY_SECOND_QUOTE_FAILED', { symbol, address: mint, error: error.message, timeMode: timeMode.name, requestedSize });
      if (cfg.rejectIfSecondQuoteFails) return { accepted: false, reason: `quote kedua gagal: ${error.message}`, first, timeMode };
      return { accepted: true, reason: 'quote kedua gagal tapi allowed by config', first, second: null, timeMode };
    }

    const buyWorsening = buyQuoteWorseningPct(first, second);
    const rtWorsening = roundTripWorseningPct(first, second);
    const sizeDropped = positionSizeDropped(first, second);

    const result = {
      accepted: true,
      first,
      second,
      timeMode,
      requestedSizeSol: requestedSize,
      buyWorseningPct: buyWorsening,
      roundTripWorseningPct: rtWorsening,
      firstPositionSizeSol: first.executedPositionSizeSol,
      secondPositionSizeSol: second.executedPositionSizeSol,
      firstRoundTripLossPct: first.roundTrip?.roundTripLossPct,
      secondRoundTripLossPct: second.roundTrip?.roundTripLossPct
    };

    console.log(chalk.gray(`   Buy quote worsening: ${buyWorsening.toFixed(2)}% / limit ${cfg.maxBuyQuoteWorseningPct}%`));
    console.log(chalk.gray(`   Round-trip worsening: ${rtWorsening.toFixed(2)}% / limit ${cfg.maxRoundTripLossWorseningPct}%`));
    console.log(chalk.gray(`   Position size: ${first.executedPositionSizeSol} SOL -> ${second.executedPositionSizeSol} SOL`));

    if (buyWorsening > cfg.maxBuyQuoteWorseningPct) {
      result.accepted = false;
      result.reason = `buy quote memburuk ${buyWorsening.toFixed(2)}% > ${cfg.maxBuyQuoteWorseningPct}% (${timeMode.name})`;
    }

    if (result.accepted && rtWorsening > cfg.maxRoundTripLossWorseningPct) {
      result.accepted = false;
      result.reason = `round-trip loss memburuk ${rtWorsening.toFixed(2)}% > ${cfg.maxRoundTripLossWorseningPct}% (${timeMode.name})`;
    }

    if (result.accepted && cfg.rejectIfPositionSizeDrops && sizeDropped) {
      result.accepted = false;
      result.reason = `position size turun dari ${first.executedPositionSizeSol} ke ${second.executedPositionSizeSol} SOL`;
    }

    if (result.accepted) {
      const observer = await this.runJupiterObserver(token, tokenDecimals, requestedSize);
      result.jupiterObserver = observer;
      if (!observer.accepted) {
        result.accepted = false;
        result.reason = observer.reason;
      }
    }

    activityLogger.log(result.accepted ? 'PRE_ENTRY_STABILITY_ACCEPTED' : 'PRE_ENTRY_STABILITY_REJECTED', {
      symbol,
      address: mint,
      timeMode: timeMode.name,
      hour: timeMode.hour,
      requestedSize,
      buyWorseningPct: buyWorsening,
      roundTripWorseningPct: rtWorsening,
      firstPositionSizeSol: first.executedPositionSizeSol,
      secondPositionSizeSol: second.executedPositionSizeSol,
      jupiterObserver: result.jupiterObserver ? {
        accepted: result.jupiterObserver.accepted,
        reason: result.jupiterObserver.reason,
        exitSolDropPct: result.jupiterObserver.exitSolDropPct,
        roundTripLossIncreasePct: result.jupiterObserver.roundTripLossIncreasePct,
        sellImpactMax: result.jupiterObserver.sellImpactMax,
        flatDex: result.jupiterObserver.flatDex
      } : null,
      reason: result.reason
    });

    return result;
  };

  const originalOpenPosition = engine.openPosition?.bind(engine);

  engine.openPosition = async function patchedOpenPosition(token) {
    if (this.currentPosition) return originalOpenPosition(token);

    const tokenDecimals = token.baseToken.decimals || token.info?.decimals || config.trading.defaultTokenDecimals || 6;
    const check = await this.runPreEntryStabilityCheck(token, tokenDecimals);

    if (!check.accepted) {
      console.log(chalk.yellow(`[PreEntry Stability] Entry ditolak: ${check.reason}`));
      return;
    }

    token.timeRiskMode = check.timeMode?.name;
    token.timeRiskHour = check.timeMode?.hour;
    token.timeRiskRequestedSizeSol = check.requestedSizeSol;
    token.jupiterObserver = check.jupiterObserver ? {
      accepted: check.jupiterObserver.accepted,
      flatDex: check.jupiterObserver.flatDex,
      exitSolStart: check.jupiterObserver.exitSolStart,
      exitSolEnd: check.jupiterObserver.exitSolEnd,
      exitSolDropPct: check.jupiterObserver.exitSolDropPct,
      roundTripLossStart: check.jupiterObserver.roundTripLossStart,
      roundTripLossEnd: check.jupiterObserver.roundTripLossEnd,
      roundTripLossIncreasePct: check.jupiterObserver.roundTripLossIncreasePct,
      sellImpactMax: check.jupiterObserver.sellImpactMax,
      allExitSolTicksDown: check.jupiterObserver.allExitSolTicksDown,
      limits: check.jupiterObserver.limits,
      samples: check.jupiterObserver.samples
    } : null;
    token.preEntryStability = {
      buyWorseningPct: check.buyWorseningPct,
      roundTripWorseningPct: check.roundTripWorseningPct,
      firstPositionSizeSol: check.firstPositionSizeSol,
      secondPositionSizeSol: check.secondPositionSizeSol,
      firstRoundTripLossPct: check.firstRoundTripLossPct,
      secondRoundTripLossPct: check.secondRoundTripLossPct
    };

    const originalPositionSize = config.trading.positionSize;
    if (check.requestedSizeSol && check.requestedSizeSol !== originalPositionSize) config.trading.positionSize = check.requestedSizeSol;

    try {
      console.log(chalk.green(`[PreEntry Stability] Quote stabil + Jupiter observer lolos. Lanjut entry final.`));
      return await originalOpenPosition(token);
    } finally {
      config.trading.positionSize = originalPositionSize;
    }
  };

  engine.__preEntryStabilityPatchApplied = true;
  return engine;
}

module.exports = applyPreEntryStabilityPatch;
