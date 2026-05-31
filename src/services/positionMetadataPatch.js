const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');

function applyPositionMetadataPatch(engine) {
  if (!engine || engine.__positionMetadataPatchApplied) return engine;

  const originalOpenPosition = engine.openPosition?.bind(engine);

  engine.openPosition = async function patchedOpenPositionMetadata(token) {
    const result = await originalOpenPosition(token);

    if (this.currentPosition) {
      if (token.jupiterObserver) this.currentPosition.jupiterObserver = token.jupiterObserver;
      if (token.preEntryStability) this.currentPosition.preEntryStability = token.preEntryStability;
      if (token.timeRiskMode) this.currentPosition.timeRiskMode = token.timeRiskMode;
      if (token.timeRiskHour !== undefined) this.currentPosition.timeRiskHour = token.timeRiskHour;
      if (token.timeRiskRequestedSizeSol !== undefined) this.currentPosition.timeRiskRequestedSizeSol = token.timeRiskRequestedSizeSol;

      storage.saveActivePosition(this.currentPosition);
      activityLogger.log('POSITION_METADATA_PATCHED', {
        symbol: this.currentPosition.symbol,
        address: this.currentPosition.address,
        hasJupiterObserver: Boolean(this.currentPosition.jupiterObserver),
        hasPreEntryStability: Boolean(this.currentPosition.preEntryStability)
      });
    }

    return result;
  };

  engine.__positionMetadataPatchApplied = true;
  return engine;
}

module.exports = applyPositionMetadataPatch;
