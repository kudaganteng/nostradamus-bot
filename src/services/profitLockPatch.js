const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getProfitLockConfig() {
  const lock = config.trading?.profitLock || {};
  return {
    enabled: lock.enabled === true,
    confirmTicks: Math.max(1, n(lock.confirmTicks, 2)),
    tiers: Array.isArray(lock.tiers) ? lock.tiers : []
  };
}

function selectTier(maxPnl, tiers) {
  return [...tiers]
    .map(tier => ({ maxPnl: n(tier.maxPnl), lockPnl: n(tier.lockPnl) }))
    .filter(tier => maxPnl >= tier.maxPnl)
    .sort((a, b) => b.maxPnl - a.maxPnl)[0] || null;
}

function applyProfitLockPatch(engine) {
  if (!engine || engine.__profitLockPatchApplied) return engine;
  const originalCheckExitConditions = engine.checkExitConditions?.bind(engine);

  engine.checkExitConditions = function patchedCheckExitConditions(currentPrice, pnl, maxPnl) {
    if (this.isClosing) return;

    const lock = getProfitLockConfig();
    if (lock.enabled && this.currentPosition) {
      const tier = selectTier(maxPnl, lock.tiers);

      if (tier && pnl < tier.lockPnl) {
        this.currentPosition.profitLockConfirmTicks = n(this.currentPosition.profitLockConfirmTicks, 0) + 1;
        this.currentPosition.activeProfitLockTier = tier;

        activityLogger.log('PROFIT_LOCK_WARNING', {
          symbol: this.currentPosition.symbol,
          pnl,
          maxPnl,
          tier,
          confirmTicks: this.currentPosition.profitLockConfirmTicks,
          requiredConfirmTicks: lock.confirmTicks
        });

        if (this.currentPosition.profitLockConfirmTicks >= lock.confirmTicks) {
          this.closePosition(
            currentPrice,
            pnl,
            `🔒 Tiered Profit Lock: Max ${maxPnl.toFixed(2)}%, turun di bawah ${tier.lockPnl}% (${lock.confirmTicks} tick)`
          );
          return;
        }
      } else {
        this.currentPosition.profitLockConfirmTicks = 0;
        this.currentPosition.activeProfitLockTier = tier || null;
      }
    }

    return originalCheckExitConditions(currentPrice, pnl, maxPnl);
  };

  engine.__profitLockPatchApplied = true;
  return engine;
}

module.exports = applyProfitLockPatch;
