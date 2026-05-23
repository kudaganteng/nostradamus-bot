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
    if (Array.isArray(mode.hours) && mode.hours.includes(hour)) {
      return { name, hour, ...mode };
    }
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

function applyPreEntryStabilityPatch(engine) {
  if (!engine || engine.__preEntryStabilityPatchApplied) return engine;

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
    token.preEntryStability = {
      buyWorseningPct: check.buyWorseningPct,
      roundTripWorseningPct: check.roundTripWorseningPct,
      firstPositionSizeSol: check.firstPositionSizeSol,
      secondPositionSizeSol: check.secondPositionSizeSol,
      firstRoundTripLossPct: check.firstRoundTripLossPct,
      secondRoundTripLossPct: check.secondRoundTripLossPct
    };

    const originalPositionSize = config.trading.positionSize;
    if (check.requestedSizeSol && check.requestedSizeSol !== originalPositionSize) {
      config.trading.positionSize = check.requestedSizeSol;
    }

    try {
      console.log(chalk.green(`[PreEntry Stability] Quote stabil. Lanjut entry final. Mode=${check.timeMode?.name || 'off'}`));
      return await originalOpenPosition(token);
    } finally {
      config.trading.positionSize = originalPositionSize;
    }
  };

  engine.__preEntryStabilityPatchApplied = true;
  return engine;
}

module.exports = applyPreEntryStabilityPatch;
