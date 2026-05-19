const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getNetSolPnl(position, quoteSnapshot) {
  const entrySol = n(position.entrySolValue, n(position.positionSize, 0));
  const exitSol = n(quoteSnapshot.exitSolAmount, 0);
  const entryFeeSol = n(position.entryEstimatedFeeSol, 0);
  const exitFeeSol = n(quoteSnapshot.quote?.estimatedFeeSol, 0);
  const netProfitSol = exitSol - entrySol - entryFeeSol - exitFeeSol;
  const netPnlPercent = entrySol > 0 ? (netProfitSol / entrySol) * 100 : 0;
  const grossPnlPercent = entrySol > 0 ? ((exitSol - entrySol) / entrySol) * 100 : 0;

  return {
    entrySol,
    exitSol,
    entryFeeSol,
    exitFeeSol,
    netProfitSol,
    netPnlPercent,
    grossPnlPercent
  };
}

function syntheticPriceFromPnl(position, pnlPercent) {
  const entryPrice = n(position.entryPrice, 0);
  return entryPrice > 0 ? entryPrice * (1 + pnlPercent / 100) : 0;
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
    const looksLikeProfitExit = reason.includes('Moon Target') || reason.includes('Profit Lock') || reason.includes('Trailing Stop');

    if (looksLikeProfitExit && finalPnl < 0) {
      last.originalReason = last.reason;
      last.reason = `⚠️ SELL_REQUOTE_DEGRADED: indikasi ${indicativePnl.toFixed(2)}%, final ${finalPnl.toFixed(2)}%`;
      last.executionMismatch = true;
      trades[trades.length - 1] = last;
      fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2), 'utf8');
      activityLogger.log('SELL_REQUOTE_DEGRADED_PATCHED', {
        symbol: last.symbol,
        originalReason: last.originalReason,
        finalReason: last.reason,
        indicativePnl,
        finalPnl,
        sellQuoteWorseningPct: last.sellQuoteWorseningPct
      });
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
          console.log(chalk.red('Gagal mendapatkan exitSolAmount Jupiter terbaru, mencoba lagi...'));
          return;
        }

        const solPnl = getNetSolPnl(this.currentPosition, quoteSnapshot);
        const pnl = solPnl.netPnlPercent;
        const grossPnl = solPnl.grossPnlPercent;
        const currentPrice = syntheticPriceFromPnl(this.currentPosition, pnl);

        this.currentPosition.lastIndicativeExitSolAmount = solPnl.exitSol;
        this.currentPosition.lastIndicativeNetProfitSol = solPnl.netProfitSol;
        this.currentPosition.lastIndicativeNetPnlPercent = pnl;
        this.currentPosition.lastIndicativeGrossPnlPercent = grossPnl;
        this.currentPosition.lastIndicativeExitFeeSol = solPnl.exitFeeSol;
        this.currentPosition.lastIndicativePriceUsd = quoteSnapshot.price;

        if (!Number.isFinite(this.currentPosition.maxSolPnlPercent) || pnl > this.currentPosition.maxSolPnlPercent) {
          this.currentPosition.maxSolPnlPercent = pnl;
          this.currentPosition.maxExitSolAmount = solPnl.exitSol;
          this.currentPosition.maxPrice = currentPrice;
        }

        const maxPnl = n(this.currentPosition.maxSolPnlPercent, pnl);
        process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: Net SOL PNL ${pnl.toFixed(2)}% | Gross ${grossPnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}% | Out ${solPnl.exitSol.toFixed(6)} SOL | Impact ${quoteSnapshot.priceImpactPct}%    `));

        this.checkExitConditions(currentPrice, pnl, maxPnl);
      } catch (error) {
        console.error(chalk.red('\nError refresh quote Jupiter SOL PNL:'), error.message);
      }
    }, refreshMs);
  };

  engine.closePosition = async function patchedClosePosition(indicativePrice, indicativePnl, reason) {
    await originalClosePosition(indicativePrice, indicativePnl, reason);
    patchLastTradeReasonIfNeeded();
  };

  engine.__solPnlPatchApplied = true;
  return engine;
}

module.exports = applySolPnlPatch;
