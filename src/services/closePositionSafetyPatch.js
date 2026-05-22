const chalk = require('chalk');
const activityLogger = require('../utils/activityLogger');
const storage = require('../utils/storage');

function applyClosePositionSafetyPatch(engine) {
  if (!engine || engine.__closePositionSafetyPatchApplied) return engine;

  const previousClosePosition = engine.closePosition?.bind(engine);

  engine.closePosition = async function safeClosePosition(indicativePrice, indicativePnl, reason) {
    const positionSnapshot = this.currentPosition ? { ...this.currentPosition } : null;

    try {
      return await previousClosePosition(indicativePrice, indicativePnl, reason);
    } catch (error) {
      activityLogger.log('CLOSE_POSITION_CRASH_PREVENTED', {
        symbol: positionSnapshot?.symbol,
        address: positionSnapshot?.address,
        reason,
        error: error.message,
        stack: error.stack
      });

      console.log(chalk.red(`\n[Close Safety] closePosition error dicegah: ${error.message}`));

      if (positionSnapshot && !this.currentPosition) {
        this.currentPosition = positionSnapshot;
        storage.saveActivePosition(positionSnapshot);
        console.log(chalk.yellow(`[Close Safety] Posisi ${positionSnapshot.symbol} direstore, monitoring dilanjutkan.`));
      }

      this.isClosing = false;
      if (this.currentPosition && !this.checkInterval) {
        this.startMonitoring();
      }
      return;
    }
  };

  engine.__closePositionSafetyPatchApplied = true;
  return engine;
}

module.exports = applyClosePositionSafetyPatch;
