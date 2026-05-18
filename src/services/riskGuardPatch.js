const config = require('../../config.json');
const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getDailyRiskConfig() {
  const d = config.dailyRisk || {};
  return {
    enabled: d.enabled === true,
    maxDailyLossSol: Math.max(0, n(d.maxDailyLossSol, 0.1)),
    maxDailyLossPercent: Math.max(0, n(d.maxDailyLossPercent, 10)),
    pauseMinutesAfterDailyLoss: Math.max(1, n(d.pauseMinutesAfterDailyLoss, 1440))
  };
}

function getExitRiskConfig() {
  const e = config.exitRisk || {};
  return {
    enabled: e.enabled === true,
    softExitImpactPct: Math.max(0, n(e.softExitImpactPct, 0.05)),
    softConfirmTicks: Math.max(1, n(e.softConfirmTicks, 2)),
    hardExitImpactPct: Math.max(0, n(e.hardExitImpactPct, 0.1)),
    blacklistLossPercent: n(e.blacklistLossPercent, -15),
    blacklistExitImpactPct: Math.max(0, n(e.blacklistExitImpactPct, 0.1)),
    cooldownAfterLossMinutes: Math.max(1, n(e.cooldownAfterLossMinutes, 60)),
    blacklistAfterLossCount: Math.max(1, n(e.blacklistAfterLossCount, 2))
  };
}

function getDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = (typeof storage.getTrades === 'function' ? storage.getTrades() : require('fs').existsSync('paperTrades.json') ? JSON.parse(require('fs').readFileSync('paperTrades.json', 'utf8')) : [])
    .filter(trade => String(trade.closedAt || '').startsWith(today));
  const netSol = trades.reduce((sum, trade) => sum + n(trade.netProfitSol ?? trade.netPnlSol, 0), 0);
  const portfolio = storage.getPortfolio();
  const startBalance = n(portfolio.startBalance, n(config.trading?.paperBalance, 1));
  const pnlPercent = startBalance > 0 ? (netSol / startBalance) * 100 : 0;
  return { trades, netSol, pnlPercent };
}

function dailyLossHit() {
  const cfg = getDailyRiskConfig();
  if (!cfg.enabled) return { hit: false };
  const stats = getDailyStats();
  const lossSol = Math.max(0, -stats.netSol);
  const lossPercent = Math.max(0, -stats.pnlPercent);
  const hitSol = cfg.maxDailyLossSol > 0 && lossSol >= cfg.maxDailyLossSol;
  const hitPercent = cfg.maxDailyLossPercent > 0 && lossPercent >= cfg.maxDailyLossPercent;
  if (!hitSol && !hitPercent) return { hit: false, ...stats };
  return {
    hit: true,
    reason: hitSol ? `Daily loss ${lossSol.toFixed(6)} SOL >= ${cfg.maxDailyLossSol} SOL` : `Daily loss ${lossPercent.toFixed(2)}% >= ${cfg.maxDailyLossPercent}%`,
    lossSol,
    lossPercent,
    ...stats
  };
}

function applyRiskGuardPatch(engine) {
  if (!engine || engine.__riskGuardPatchApplied) return engine;

  const originalOpenPosition = engine.openPosition?.bind(engine);
  const originalGetIndicative = engine.getIndicativePriceFromJupiterQuote?.bind(engine);
  const originalClosePosition = engine.closePosition?.bind(engine);

  engine.openPosition = async function patchedOpenPosition(token) {
    const state = storage.getState();
    if (state.globalPauseUntil && state.globalPauseUntil > Date.now()) {
      const minutes = Math.ceil((state.globalPauseUntil - Date.now()) / 60000);
      console.log(`\n[DAILY RISK] Entry ditolak. Global pause masih ${minutes} menit.`);
      return;
    }

    const daily = dailyLossHit();
    if (daily.hit) {
      const cfg = getDailyRiskConfig();
      state.globalPauseUntil = Date.now() + cfg.pauseMinutesAfterDailyLoss * 60 * 1000;
      state.dailyRiskTriggeredAt = new Date().toISOString();
      state.dailyRiskReason = daily.reason;
      storage.saveState(state);
      activityLogger.log('DAILY_LOSS_LIMIT_HIT', daily);
      console.log(`\n[DAILY RISK] Entry ditolak: ${daily.reason}`);
      return;
    }

    return originalOpenPosition(token);
  };

  engine.getIndicativePriceFromJupiterQuote = async function patchedGetIndicativePriceFromJupiterQuote() {
    const snapshot = await originalGetIndicative();
    const cfg = getExitRiskConfig();
    if (!cfg.enabled || !this.currentPosition) return snapshot;

    const impact = Math.abs(n(snapshot.priceImpactPct, 0));
    this.currentPosition.lastExitImpactPct = impact;

    if (impact >= cfg.hardExitImpactPct) {
      activityLogger.log('EXIT_IMPACT_HARD_TRIGGER', { symbol: this.currentPosition.symbol, impact, threshold: cfg.hardExitImpactPct });
      setImmediate(() => this.closePosition(snapshot.price, 0, `🚨 Exit Impact Hard Guard: impact ${impact.toFixed(4)} >= ${cfg.hardExitImpactPct}`));
      return snapshot;
    }

    if (impact >= cfg.softExitImpactPct) {
      this.currentPosition.exitImpactConfirmTicks = n(this.currentPosition.exitImpactConfirmTicks, 0) + 1;
      activityLogger.log('EXIT_IMPACT_WARNING', { symbol: this.currentPosition.symbol, impact, confirmTicks: this.currentPosition.exitImpactConfirmTicks, required: cfg.softConfirmTicks });
      if (this.currentPosition.exitImpactConfirmTicks >= cfg.softConfirmTicks) {
        setImmediate(() => this.closePosition(snapshot.price, 0, `⚠️ Exit Impact Soft Guard: impact ${impact.toFixed(4)} selama ${cfg.softConfirmTicks} tick`));
      }
    } else {
      this.currentPosition.exitImpactConfirmTicks = 0;
    }

    return snapshot;
  };

  engine.closePosition = async function patchedClosePosition(indicativePrice, indicativePnl, reason) {
    await originalClosePosition(indicativePrice, indicativePnl, reason);

    const cfg = getExitRiskConfig();
    const daily = dailyLossHit();
    const state = storage.getState();

    if (daily.hit) {
      const d = getDailyRiskConfig();
      state.globalPauseUntil = Math.max(n(state.globalPauseUntil, 0), Date.now() + d.pauseMinutesAfterDailyLoss * 60 * 1000);
      state.dailyRiskTriggeredAt = new Date().toISOString();
      state.dailyRiskReason = daily.reason;
      activityLogger.log('DAILY_LOSS_LIMIT_HIT', daily);
    }

    const trades = require('fs').existsSync('paperTrades.json') ? JSON.parse(require('fs').readFileSync('paperTrades.json', 'utf8')) : [];
    const lastTrade = trades[trades.length - 1];
    if (cfg.enabled && lastTrade?.address) {
      state.tokenStats[lastTrade.address] = state.tokenStats[lastTrade.address] || { slCount: 0, cooldownUntil: 0, blacklisted: false };
      const t = state.tokenStats[lastTrade.address];
      const pnl = n(lastTrade.pnl, 0);
      const exitImpact = Math.abs(n(lastTrade.exitPriceImpactPct, 0));

      if (pnl < 0) {
        t.cooldownUntil = Math.max(n(t.cooldownUntil, 0), Date.now() + cfg.cooldownAfterLossMinutes * 60 * 1000);
      }
      if (pnl <= cfg.blacklistLossPercent || exitImpact >= cfg.blacklistExitImpactPct || n(t.slCount, 0) >= cfg.blacklistAfterLossCount) {
        t.blacklisted = true;
        t.blacklistReason = pnl <= cfg.blacklistLossPercent ? `loss ${pnl.toFixed(2)}%` : exitImpact >= cfg.blacklistExitImpactPct ? `exitImpact ${exitImpact}` : `lossCount ${t.slCount}`;
        t.blacklistedAt = new Date().toISOString();
        activityLogger.log('TOKEN_SESSION_BLACKLISTED', { symbol: lastTrade.symbol, address: lastTrade.address, reason: t.blacklistReason, pnl, exitImpact, slCount: t.slCount });
      }
      state.tokenStats[lastTrade.address] = t;
    }

    storage.saveState(state);
  };

  engine.__riskGuardPatchApplied = true;
  return engine;
}

module.exports = applyRiskGuardPatch;
