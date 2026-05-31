const config = require('../../config.json');
const jupiter = require('./jupiter');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applyHighRiskEntryPatch() {
  if (jupiter.__highRiskEntryPatchApplied) return jupiter;

  const originalGetBuyExecution = jupiter.getBuyExecution.bind(jupiter);

  jupiter.getBuyExecution = async function patchedGetBuyExecution(tokenMint, requestedPositionSizeSol, tokenDecimals) {
    const execution = await originalGetBuyExecution(tokenMint, requestedPositionSizeSol, tokenDecimals);
    const highLoss = n(config.jupiter?.highRoundTripLossPct, 2.5);
    const highMaxSellImpact = n(config.jupiter?.highRoundTripMaxSellImpactPct, 0.028);
    const rtLoss = n(execution.roundTrip?.roundTripLossPct, 0);
    const sellImpact = n(execution.roundTrip?.sellImpactPct, 0);

    if (rtLoss >= highLoss && sellImpact > highMaxSellImpact) {
      const reason = `High-risk entry rejected: roundTripLoss ${rtLoss.toFixed(2)}% >= ${highLoss}% dan sellImpact ${sellImpact.toFixed(4)} > ${highMaxSellImpact}`;
      activityLogger.log('HIGH_RISK_ENTRY_REJECTED', {
        tokenMint,
        requestedPositionSizeSol,
        executedPositionSizeSol: execution.executedPositionSizeSol,
        roundTripLossPct: rtLoss,
        sellImpactPct: sellImpact,
        reason
      });
      throw new Error(reason);
    }

    return execution;
  };

  jupiter.__highRiskEntryPatchApplied = true;
  return jupiter;
}

module.exports = applyHighRiskEntryPatch;
