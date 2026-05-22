const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRateLimited(error) {
  const status = error?.response?.status;
  const message = String(error?.message || '').toLowerCase();
  return status === 429 || message.includes('429') || message.includes('rate limit');
}

function getExitRiskConfig() {
  const e = config.exitRisk || {};
  return {
    rugpullPnlPercent: n(e.rugpullPnlPercent, -25),
    rugpullExitImpactPct: n(e.rugpullExitImpactPct, 0.5),
    rugpullOutputDropPct: n(e.rugpullOutputDropPct, 30),
    nearZeroExitSolPct: n(e.nearZeroExitSolPct, 10)
  };
}

function getNetSolPnl(position, quoteSnapshot) {
  const entrySol = n(position.entrySolValue, n(position.positionSize, 0));
  const exitSol = n(quoteSnapshot.exitSolAmount, 0);
  const entryFeeSol = n(position.entryEstimatedFeeSol, 0);
  const exitFeeSol = n(quoteSnapshot.quote?.estimatedFeeSol, 0);
  const netProfitSol = exitSol - entrySol - entryFeeSol - exitFeeSol;
  const netPnlPercent = entrySol > 0 ? (netProfitSol / entrySol) * 100 : 0;
  const grossPnlPercent = entrySol > 0 ? ((exitSol - entrySol) / entrySol) * 100 : 0;
  return { entrySol, exitSol, entryFeeSol, exitFeeSol, netProfitSol, netPnlPercent, grossPnlPercent };
}

function syntheticPriceFromPnl(position, pnlPercent) {
  const entryPrice = n(position.entryPrice, 0);
  return entryPrice > 0 ? entryPrice * (1 + pnlPercent / 100) : 0;
}

function writeStatusLine(message) {
  const columns = process.stdout.columns || 120;
  const maxLen = Math.max(40, columns - 2);
  const clean = String(message).replace(/\s+/g, ' ');
  const clipped = clean.length > maxLen ? `${clean.slice(0, maxLen - 3)}...` : clean;
  if (process.stdout.clearLine && process.stdout.cursorTo) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(clipped);
  } else {
    process.stdout.write(`\r${clipped.padEnd(maxLen, ' ')}`);
  }
}

function getExitKind(reason = '') {
  const text = String(reason);
  if (text.includes('Moon Target')) return 'take_profit';
  if (text.includes('Stop Loss')) return 'stop_loss';
  if (text.includes('Profit Lock')) return 'profit_lock';
  if (text.includes('Trailing Stop')) return 'trailing_stop';
  if (text.includes('Exit Impact') || text.includes('RUGPULL') || text.includes('Rugpull') || text.includes('Hard Guard')) return 'emergency';
  if (text.includes('Time Limit')) return 'time_limit';
  return 'other';
}

function getExitThreshold(position, kind) {
  const trading = config.trading || {};
  if (kind === 'take_profit') return n(position.dynamicTargetProfitPercent, n(trading.targetProfitPercent, 7));
  if (kind === 'stop_loss') return -Math.abs(n(position.telegramStopLossPercent, n(trading.stopLossPercent, 7)));
  if (kind === 'profit_lock') return n(position.activeProfitLockTier?.lockPnl, 0);
  if (kind === 'trailing_stop') return 0;
  return null;
}

function shouldCancelExit({ kind, triggerPnl, confirmPnl, threshold }) {
  if (kind === 'emergency' || kind === 'time_limit') return { cancel: false, reason: 'non_revalidated_exit' };
  if (kind === 'take_profit' && confirmPnl < threshold) return { cancel: true, reason: `TP tidak valid lagi: confirm ${confirmPnl.toFixed(2)}% < target ${threshold}%` };
  if (kind === 'stop_loss' && confirmPnl > threshold) return { cancel: true, reason: `SL tidak valid lagi: confirm ${confirmPnl.toFixed(2)}% > SL ${threshold}%` };
  if (kind === 'profit_lock' && (confirmPnl < 0 || (threshold > 0 && confirmPnl > threshold))) return { cancel: true, reason: `Profit lock tidak valid lagi: confirm ${confirmPnl.toFixed(2)}%, lock ${threshold}%` };
  if (kind === 'trailing_stop' && confirmPnl < 0) return { cancel: true, reason: `Trailing profit berubah negatif: confirm ${confirmPnl.toFixed(2)}%` };

  const maxAllowedTriggerDriftPct = n(config.exitRisk?.maxExitTriggerDriftPct, 4);
  if ((kind === 'take_profit' || kind === 'profit_lock' || kind === 'trailing_stop') && triggerPnl - confirmPnl > maxAllowedTriggerDriftPct) {
    return { cancel: true, reason: `Quote drift terlalu besar: trigger ${triggerPnl.toFixed(2)}% -> confirm ${confirmPnl.toFixed(2)}%` };
  }
  return { cancel: false, reason: 'confirmed' };
}

function getRugpullReason(position, solPnl, quoteSnapshot) {
  const risk = getExitRiskConfig();
  const impact = Math.abs(n(quoteSnapshot.priceImpactPct, 0));
  const previousExitSol = n(position.previousExitSolAmount, 0);
  const entrySol = n(position.entrySolValue, n(position.positionSize, 0));
  const dropPct = previousExitSol > 0 ? ((previousExitSol - solPnl.exitSol) / previousExitSol) * 100 : 0;
  const nearZeroPct = entrySol > 0 ? (solPnl.exitSol / entrySol) * 100 : 100;

  if (solPnl.netPnlPercent <= risk.rugpullPnlPercent) return `🚨 Rugpull Emergency: Net PNL ${solPnl.netPnlPercent.toFixed(2)}% <= ${risk.rugpullPnlPercent}%`;
  if (impact >= risk.rugpullExitImpactPct) return `🚨 Rugpull Emergency: Exit impact ${impact.toFixed(4)} >= ${risk.rugpullExitImpactPct}`;
  if (previousExitSol > 0 && dropPct >= risk.rugpullOutputDropPct) return `🚨 Rugpull Emergency: exit output drop ${dropPct.toFixed(2)}% >= ${risk.rugpullOutputDropPct}%`;
  if (nearZeroPct <= risk.nearZeroExitSolPct) return `🚨 Rugpull Emergency: exit output near-zero ${nearZeroPct.toFixed(2)}% of entry`;
  return null;
}

function patchLastTradeReasonIfNeeded() {
  const tradesFile = path.join(process.cwd(), 'paperTrades.json');
  if (!fs.existsSync(tradesFile)) return;
  try {
    const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8') || '[]');
    if (!Array.isArray(trades) || trades.length === 0) return;
    const last = trades[trades.length - 1];
    if (!last) return;
    const reason = String(last.reason || '');
    const finalPnl = n(last.pnl, 0);
    const indicativePnl = n(last.indicativePnl, 0);
    const kind = getExitKind(reason);
    const target = n(last.dynamicTargetProfitPercent, n(config.trading?.targetProfitPercent, 7));
    const looksLikeProfitExit = kind === 'take_profit' || kind === 'profit_lock' || kind === 'trailing_stop';
    const degradedProfitExit = looksLikeProfitExit && (finalPnl < 0 || (kind === 'take_profit' && finalPnl < target));
    if (degradedProfitExit) {
      last.originalReason = last.reason;
      last.reason = `SELL_REQUOTE_DEGRADED: indikasi ${indicativePnl.toFixed(2)}%, final ${finalPnl.toFixed(2)}%`;
      last.executionMismatch = true;
      trades[trades.length - 1] = last;
      fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2), 'utf8');
      activityLogger.log('SELL_REQUOTE_DEGRADED_PATCHED', { symbol: last.symbol, originalReason: last.originalReason, finalReason: last.reason, indicativePnl, finalPnl, sellQuoteWorseningPct: last.sellQuoteWorseningPct });
    }
  } catch (error) {
    activityLogger.log('SELL_REQUOTE_DEGRADED_PATCH_ERROR', { error: error.message });
  }
}

function applySolPnlPatch(engine) {
  if (!engine || engine.__solPnlPatchApplied) return engine;
  const originalClosePosition = engine.closePosition?.bind(engine);

  engine.fallbackToPolling = function patchedFallbackToPolling() {
    if (this.checkInterval || !this.currentPosition) return;
    const refreshMs = this.getMonitoringConfig().quoteRefreshMs;
    console.log(chalk.yellow(`Mengaktifkan refresh quote Jupiter setiap ${refreshMs / 1000} detik dengan SOL-based PNL...`));

    this.checkInterval = setInterval(async () => {
      try {
        if (!this.currentPosition) {
          this.stopMonitoring();
          return;
        }

        const quoteSnapshot = await this.getIndicativePriceFromJupiterQuote();
        if (!quoteSnapshot || !quoteSnapshot.exitSolAmount) {
          console.log(chalk.red('\nGagal mendapatkan exitSolAmount Jupiter terbaru, mencoba lagi...'));
          return;
        }

        const solPnl = getNetSolPnl(this.currentPosition, quoteSnapshot);
        const pnl = solPnl.netPnlPercent;
        const grossPnl = solPnl.grossPnlPercent;
        const currentPrice = syntheticPriceFromPnl(this.currentPosition, pnl);
        const previousExitSolAmount = n(this.currentPosition.lastIndicativeExitSolAmount, 0);

        this.currentPosition.previousExitSolAmount = previousExitSolAmount;
        this.currentPosition.lastIndicativeExitSolAmount = solPnl.exitSol;
        this.currentPosition.lastIndicativeNetProfitSol = solPnl.netProfitSol;
        this.currentPosition.lastIndicativeNetPnlPercent = pnl;
        this.currentPosition.lastIndicativeGrossPnlPercent = grossPnl;
        this.currentPosition.lastIndicativeExitFeeSol = solPnl.exitFeeSol;
        this.currentPosition.lastIndicativePriceUsd = quoteSnapshot.price;
        this.currentPosition.lastExitTriggerQuote = { at: new Date().toISOString(), exitSolAmount: solPnl.exitSol, netPnlPercent: pnl, grossPnlPercent: grossPnl, priceUsd: quoteSnapshot.price, priceImpactPct: quoteSnapshot.priceImpactPct };

        if (!Number.isFinite(this.currentPosition.maxSolPnlPercent) || pnl > this.currentPosition.maxSolPnlPercent) {
          this.currentPosition.maxSolPnlPercent = pnl;
          this.currentPosition.maxExitSolAmount = solPnl.exitSol;
          this.currentPosition.maxPrice = currentPrice;
        }

        const maxPnl = n(this.currentPosition.maxSolPnlPercent, pnl);
        writeStatusLine(`Monitoring ${this.currentPosition.symbol}: Net ${pnl.toFixed(2)}% | Gross ${grossPnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}% | Out ${solPnl.exitSol.toFixed(6)} SOL | Impact ${n(quoteSnapshot.priceImpactPct, 0).toFixed(4)}%`);

        const rugpullReason = getRugpullReason(this.currentPosition, solPnl, quoteSnapshot);
        if (rugpullReason) {
          activityLogger.log('RUGPULL_EMERGENCY_EXIT_TRIGGERED', { symbol: this.currentPosition.symbol, address: this.currentPosition.address, reason: rugpullReason, pnl, grossPnl, exitSolAmount: solPnl.exitSol, previousExitSolAmount, priceImpactPct: quoteSnapshot.priceImpactPct });
          this.closePosition(currentPrice, pnl, rugpullReason);
          return;
        }

        this.checkExitConditions(currentPrice, pnl, maxPnl);
      } catch (error) {
        console.error(chalk.red('\nError refresh quote Jupiter SOL PNL:'), error.message);
      }
    }, refreshMs);
  };

  engine.closePosition = async function patchedClosePosition(indicativePrice, indicativePnl, reason) {
    if (!this.currentPosition) return;
    const kind = getExitKind(reason);
    const triggerPnl = n(indicativePnl, n(this.currentPosition.lastIndicativeNetPnlPercent, 0));
    const triggerPrice = syntheticPriceFromPnl(this.currentPosition, triggerPnl);
    const triggerExitSol = n(this.currentPosition.lastIndicativeExitSolAmount, 0);
    const threshold = getExitThreshold(this.currentPosition, kind);

    if (kind !== 'emergency' && kind !== 'time_limit') {
      try {
        const confirmSnapshot = await this.getIndicativePriceFromJupiterQuote();
        const confirmSolPnl = getNetSolPnl(this.currentPosition, confirmSnapshot);
        const confirmPnl = confirmSolPnl.netPnlPercent;
        const confirmPrice = syntheticPriceFromPnl(this.currentPosition, confirmPnl);
        const quoteDriftPct = triggerExitSol > 0 ? ((triggerExitSol - confirmSolPnl.exitSol) / triggerExitSol) * 100 : 0;
        const decision = shouldCancelExit({ kind, triggerPnl, confirmPnl, threshold });
        this.currentPosition.exitRevalidation = { kind, reason, triggerPnl, confirmPnl, triggerExitSol, confirmExitSol: confirmSolPnl.exitSol, quoteDriftPct, threshold, decision: decision.reason, at: new Date().toISOString() };
        if (decision.cancel) {
          activityLogger.log('EXIT_REVALIDATION_CANCELLED', this.currentPosition.exitRevalidation);
          console.log(chalk.yellow(`\n[Exit Revalidate] Batal close ${this.currentPosition.symbol}: ${decision.reason}`));
          this.isClosing = false;
          if (!this.checkInterval) this.startMonitoring();
          return;
        }
        activityLogger.log('EXIT_REVALIDATION_CONFIRMED', this.currentPosition.exitRevalidation);
        await originalClosePosition(confirmPrice, confirmPnl, reason);
        patchLastTradeReasonIfNeeded();
        return;
      } catch (error) {
        const rateLimited = isRateLimited(error);
        activityLogger.log(rateLimited ? 'EXIT_REVALIDATION_RATE_LIMIT_FALLBACK' : 'EXIT_REVALIDATION_ERROR_FALLBACK', { symbol: this.currentPosition.symbol, reason, error: error.message, triggerPnl, triggerExitSol, fallback: 'continue_close_with_trigger_quote' });
        console.log(chalk.yellow(`\n[Exit Revalidate] ${rateLimited ? 'Rate limit 429' : 'Error'} saat revalidasi: ${error.message}. Tetap exit memakai trigger quote terakhir.`));
        await originalClosePosition(triggerPrice || indicativePrice, triggerPnl, `${reason} | Revalidation unavailable, fallback trigger quote`);
        patchLastTradeReasonIfNeeded();
        return;
      }
    }

    await originalClosePosition(indicativePrice, indicativePnl, reason);
    patchLastTradeReasonIfNeeded();
  };

  engine.__solPnlPatchApplied = true;
  return engine;
}

module.exports = applySolPnlPatch;
