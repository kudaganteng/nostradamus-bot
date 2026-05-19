const chalk = require('chalk');
const storage = require('../utils/storage');

function n(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRuntimeRisk() {
  const state = storage.getState();
  const runtimeRisk = state.runtimeRisk || {};
  const targetProfitPercent = n(runtimeRisk.targetProfitPercent, null);
  const stopLossPercent = n(runtimeRisk.stopLossPercent, null);

  return {
    targetProfitPercent: targetProfitPercent && targetProfitPercent > 0 ? targetProfitPercent : null,
    stopLossPercent: stopLossPercent && stopLossPercent > 0 ? stopLossPercent : null,
    updatedAt: runtimeRisk.updatedAt || null
  };
}

function applyRuntimeRiskToPosition(engine) {
  if (!engine?.currentPosition) return;

  const runtimeRisk = getRuntimeRisk();
  let changed = false;

  if (runtimeRisk.targetProfitPercent !== null) {
    engine.currentPosition.telegramTargetProfitPercent = runtimeRisk.targetProfitPercent;
    engine.currentPosition.dynamicTargetProfitPercent = runtimeRisk.targetProfitPercent;
    changed = true;
  }

  if (runtimeRisk.stopLossPercent !== null) {
    engine.currentPosition.telegramStopLossPercent = runtimeRisk.stopLossPercent;
    changed = true;
  }

  if (changed) {
    engine.currentPosition.runtimeRiskAppliedAt = new Date().toISOString();
    storage.saveActivePosition(engine.currentPosition);
    console.log(chalk.green(`[Runtime Risk] Applied Telegram TP/SL override to ${engine.currentPosition.symbol}: TP ${engine.currentPosition.dynamicTargetProfitPercent}% | SL ${engine.currentPosition.telegramStopLossPercent || 'default'}%`));
  }
}

function applyRuntimeRiskPatch(engine) {
  if (!engine || engine.__runtimeRiskPatchApplied) return engine;

  const originalOpenPosition = engine.openPosition?.bind(engine);
  const originalRecoverOpenPosition = engine.recoverOpenPosition?.bind(engine);

  engine.openPosition = async function patchedOpenPosition(token) {
    await originalOpenPosition(token);
    applyRuntimeRiskToPosition(this);
  };

  engine.recoverOpenPosition = function patchedRecoverOpenPosition() {
    const result = originalRecoverOpenPosition ? originalRecoverOpenPosition() : undefined;
    applyRuntimeRiskToPosition(this);
    return result;
  };

  applyRuntimeRiskToPosition(engine);

  engine.__runtimeRiskPatchApplied = true;
  return engine;
}

module.exports = applyRuntimeRiskPatch;
module.exports.applyRuntimeRiskToPosition = applyRuntimeRiskToPosition;
module.exports.getRuntimeRisk = getRuntimeRisk;
