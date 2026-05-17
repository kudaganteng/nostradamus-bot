const config = require('../../config.json');
const storage = require('../utils/storage');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasExplicitRuntimeUpdate(settings) {
  return settings?.updatedBy === 'telegram' && Boolean(settings?.updatedAt);
}

function applyRuntimeOverrides(profile, settings) {
  if (!hasExplicitRuntimeUpdate(settings)) return profile;

  return {
    ...profile,
    targetProfitPercent: n(settings.targetProfitPercent, profile.targetProfitPercent),
    stopLossPercent: n(settings.stopLossPercent, profile.stopLossPercent),
    trailingStartPercent: n(settings.trailingStartPercent, profile.trailingStartPercent),
    trailingStopPercent: n(settings.trailingStopPercent, profile.trailingStopPercent)
  };
}

function applyRuntimeRiskPatch(engine) {
  if (!engine || engine.__runtimeRiskPatchApplied) return engine;

  engine.getRuntimeRiskSettings = function getRuntimeRiskSettings() {
    return storage.getRuntimeSettings();
  };

  engine.applyRuntimeSettingsToCurrentPosition = function applyRuntimeSettingsToCurrentPosition() {
    if (!this.currentPosition) return null;
    const settings = storage.getRuntimeSettings();
    if (!hasExplicitRuntimeUpdate(settings)) return this.currentPosition;

    this.currentPosition.dynamicTargetProfitPercent = n(settings.targetProfitPercent, config.trading.targetProfitPercent);
    this.currentPosition.dynamicStopLossPercent = n(settings.stopLossPercent, config.trading.stopLossPercent);
    this.currentPosition.dynamicTrailingStartPercent = n(settings.trailingStartPercent, config.trading.trailingStartPercent);
    this.currentPosition.dynamicTrailingStopPercent = n(settings.trailingStopPercent, config.trading.trailingStopPercent);
    storage.saveActivePosition(this.currentPosition);
    return this.currentPosition;
  };

  const originalGetPositionRiskProfile = engine.getPositionRiskProfile?.bind(engine);
  engine.getPositionRiskProfile = function getPositionRiskProfileWithRuntimeSettings(token, volatility) {
    const baseProfile = originalGetPositionRiskProfile
      ? originalGetPositionRiskProfile(token, volatility)
      : {
          trailingStopPercent: volatility > 1 ? 8 : volatility >= 0.5 ? 5 : 2,
          targetProfitPercent: config.trading.targetProfitPercent,
          stopLossPercent: config.trading.stopLossPercent,
          trailingStartPercent: config.trading.trailingStartPercent,
          timeLimitMinutes: config.trading.timeLimitMinutes
        };

    return applyRuntimeOverrides(baseProfile, storage.getRuntimeSettings());
  };

  engine.__runtimeRiskPatchApplied = true;
  return engine;
}

module.exports = applyRuntimeRiskPatch;
