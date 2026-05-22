const chalk = require('chalk');
const config = require('../../config.json');
const jupiter = require('./jupiter');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPreEntryConfig() {
  const p = config.preEntryStability || {};
  return {
    enabled: p.enabled === true,
    delayMs: Math.max(0, n(p.delayMs, 2500)),
    maxBuyQuoteWorseningPct: n(p.maxBuyQuoteWorseningPct, 1.5),
    maxRoundTripLossWorseningPct: n(p.maxRoundTripLossWorseningPct, 0.75),
    rejectIfSecondQuoteFails: p.rejectIfSecondQuoteFails !== false,
    rejectIfPositionSizeDrops: p.rejectIfPositionSizeDrops === true
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
    const cfg = getPreEntryConfig();
    if (!cfg.enabled) return { accepted: true, skipped: true };

    const symbol = token.baseToken.symbol;
    const mint = token.baseToken.address;
    console.log(chalk.cyan(`\n[PreEntry Stability] Mengecek stabilitas quote Jupiter untuk ${symbol}...`));

    let first;
    let second;

    try {
      first = await jupiter.getBuyExecution(mint, config.trading.positionSize, tokenDecimals);
    } catch (error) {
      activityLogger.log('PRE_ENTRY_STABILITY_FIRST_QUOTE_FAILED', { symbol, address: mint, error: error.message });
      return { accepted: false, reason: `quote pertama gagal: ${error.message}` };
    }

    await delay(cfg.delayMs);

    try {
      second = await jupiter.getBuyExecution(mint, config.trading.positionSize, tokenDecimals);
    } catch (error) {
      activityLogger.log('PRE_ENTRY_STABILITY_SECOND_QUOTE_FAILED', { symbol, address: mint, error: error.message });
      if (cfg.rejectIfSecondQuoteFails) {
        return { accepted: false, reason: `quote kedua gagal: ${error.message}`, first };
      }
      return { accepted: true, reason: 'quote kedua gagal tapi allowed by config', first, second: null };
    }

    const buyWorsening = buyQuoteWorseningPct(first, second);
    const rtWorsening = roundTripWorseningPct(first, second);
    const sizeDropped = positionSizeDropped(first, second);

    const result = {
      accepted: true,
      first,
      second,
      buyWorseningPct: buyWorsening,
      roundTripWorseningPct: rtWorsening,
      firstPositionSizeSol: first.executedPositionSizeSol,
      secondPositionSizeSol: second.executedPositionSizeSol,
      firstRoundTripLossPct: first.roundTrip?.roundTripLossPct,
      secondRoundTripLossPct: second.roundTrip?.roundTripLossPct
    };

    console.log(chalk.gray(`   Buy quote worsening: ${buyWorsening.toFixed(2)}%`));
    console.log(chalk.gray(`   Round-trip worsening: ${rtWorsening.toFixed(2)}%`));
    console.log(chalk.gray(`   Position size: ${first.executedPositionSizeSol} SOL -> ${second.executedPositionSizeSol} SOL`));

    if (buyWorsening > cfg.maxBuyQuoteWorseningPct) {
      result.accepted = false;
      result.reason = `buy quote memburuk ${buyWorsening.toFixed(2)}% > ${cfg.maxBuyQuoteWorseningPct}%`;
    }

    if (result.accepted && rtWorsening > cfg.maxRoundTripLossWorseningPct) {
      result.accepted = false;
      result.reason = `round-trip loss memburuk ${rtWorsening.toFixed(2)}% > ${cfg.maxRoundTripLossWorseningPct}%`;
    }

    if (result.accepted && cfg.rejectIfPositionSizeDrops && sizeDropped) {
      result.accepted = false;
      result.reason = `position size turun dari ${first.executedPositionSizeSol} ke ${second.executedPositionSizeSol} SOL`;
    }

    activityLogger.log(result.accepted ? 'PRE_ENTRY_STABILITY_ACCEPTED' : 'PRE_ENTRY_STABILITY_REJECTED', {
      symbol,
      address: mint,
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

    token.preEntryStability = {
      buyWorseningPct: check.buyWorseningPct,
      roundTripWorseningPct: check.roundTripWorseningPct,
      firstPositionSizeSol: check.firstPositionSizeSol,
      secondPositionSizeSol: check.secondPositionSizeSol,
      firstRoundTripLossPct: check.firstRoundTripLossPct,
      secondRoundTripLossPct: check.secondRoundTripLossPct
    };

    console.log(chalk.green('[PreEntry Stability] Quote stabil. Lanjut entry final.'));
    return originalOpenPosition(token);
  };

  engine.__preEntryStabilityPatchApplied = true;
  return engine;
}

module.exports = applyPreEntryStabilityPatch;
