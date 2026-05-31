const fs = require('fs');
const path = require('path');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function repairLastTradeIfMismatch(positionSnapshot) {
  const tradesFile = path.join(process.cwd(), 'paperTrades.json');
  if (!fs.existsSync(tradesFile)) return;

  const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8') || '[]');
  if (!Array.isArray(trades) || trades.length === 0) return;

  const last = trades[trades.length - 1];
  if (!last || last.address !== positionSnapshot?.address) return;

  const indicativePnl = n(last.indicativePnl, 0);
  const finalPnl = n(last.pnl, 0);
  const confirmedExitSol = n(positionSnapshot?.exitRevalidation?.confirmExitSol, 0);
  const entrySol = n(last.entrySolValue, 0);
  const entryFee = n(last.entryEstimatedFeeSol, 0);
  const exitFee = n(last.exitEstimatedFeeSol, 0);
  const reason = String(last.reason || '');

  const looksDegraded = reason.includes('SELL_REQUOTE_DEGRADED') || (indicativePnl > 3 && finalPnl < 0);
  if (!looksDegraded || !confirmedExitSol || !entrySol) return;

  const grossProfitSol = confirmedExitSol - entrySol;
  const netProfitSol = grossProfitSol - entryFee - exitFee;
  const grossPnl = (grossProfitSol / entrySol) * 100;
  const pnl = (netProfitSol / entrySol) * 100;

  last.repairedPaperExit = true;
  last.originalFinalExitSolAmount = last.finalExitSolAmount;
  last.originalExitSolAmount = last.exitSolAmount;
  last.originalPnl = last.pnl;
  last.originalNetProfitSol = last.netProfitSol;
  last.exitSolAmount = confirmedExitSol;
  last.finalExitSolAmount = confirmedExitSol;
  last.grossProfitSol = grossProfitSol;
  last.netProfitSol = netProfitSol;
  last.grossPnl = grossPnl;
  last.pnl = pnl;
  last.reason = `${last.originalReason || last.reason} | PAPER_REPAIRED_USING_REVALIDATED_QUOTE`;
  last.executionMismatch = false;

  trades[trades.length - 1] = last;
  fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2), 'utf8');
  activityLogger.log('PAPER_TRADE_REPAIRED_WITH_REVALIDATED_QUOTE', {
    symbol: last.symbol,
    address: last.address,
    oldPnl: finalPnl,
    newPnl: pnl,
    confirmedExitSol
  });
}

function applyPaperTradeRepairPatch(engine) {
  if (!engine || engine.__paperTradeRepairPatchApplied) return engine;

  const previousClosePosition = engine.closePosition?.bind(engine);

  engine.closePosition = async function patchedPaperTradeRepairClose(indicativePrice, indicativePnl, reason) {
    const snapshot = this.currentPosition ? JSON.parse(JSON.stringify(this.currentPosition)) : null;
    const result = await previousClosePosition(indicativePrice, indicativePnl, reason);
    try {
      repairLastTradeIfMismatch(snapshot);
    } catch (error) {
      activityLogger.log('PAPER_TRADE_REPAIR_ERROR', { error: error.message, symbol: snapshot?.symbol, address: snapshot?.address });
    }
    return result;
  };

  engine.__paperTradeRepairPatchApplied = true;
  return engine;
}

module.exports = applyPaperTradeRepairPatch;
