const axios = require('axios');
const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

class GmgnService {
  constructor() {
    this.baseUrl = 'https://gmgn.ai';
  }

  getConfig() {
    const gmgn = config.gmgn || {};
    return {
      enabled: gmgn.enabled === true,
      timeoutMs: Math.max(500, n(gmgn.timeoutMs, 5000)),
      rejectOnError: gmgn.rejectOnError === true,
      maxTop10HolderRate: Math.max(0, n(gmgn.maxTop10HolderRate, 0.35)),
      requireRenouncedMint: gmgn.requireRenouncedMint !== false,
      requireRenouncedFreeze: gmgn.requireRenouncedFreeze !== false,
      rejectHoneypot: gmgn.rejectHoneypot !== false,
      maxBuyTax: Math.max(0, n(gmgn.maxBuyTax, 0)),
      maxSellTax: Math.max(0, n(gmgn.maxSellTax, 0)),
      requireLaunchpadComplete: gmgn.requireLaunchpadComplete !== false,
      allowedLaunchpads: Array.isArray(gmgn.allowedLaunchpads) ? gmgn.allowedLaunchpads : []
    };
  }

  async request(path) {
    const cfg = this.getConfig();
    const response = await axios.get(`${this.baseUrl}${path}`, {
      timeout: cfg.timeoutMs,
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0',
        referer: 'https://gmgn.ai/',
        origin: 'https://gmgn.ai'
      }
    });
    return response.data;
  }

  async getTokenSecurity(tokenAddress) {
    return this.request(`/api/v1/mutil_window_token_security_launchpad/sol/${tokenAddress}`);
  }

  validateSecurityPayload(payload) {
    const cfg = this.getConfig();
    const data = payload?.data || payload;
    const security = data?.security || {};
    const launchpad = data?.launchpad || {};
    const reasons = [];

    const isShowAlert = bool(security.is_show_alert, false);
    const top10HolderRate = n(security.top_10_holder_rate, 0);
    const renouncedMint = bool(security.renounced_mint, false);
    const renouncedFreeze = bool(security.renounced_freeze_account, false);
    const isHoneypot = bool(security.is_honeypot, false);
    const buyTax = n(security.buy_tax, 0);
    const sellTax = n(security.sell_tax, 0);
    const launchpadPlatform = launchpad.launchpad_platform || null;
    const launchpadProgress = n(launchpad.launchpad_progress, 0);

    if (isShowAlert) reasons.push('GMGN alert aktif');
    if (cfg.rejectHoneypot && isHoneypot) reasons.push('honeypot');
    if (cfg.requireRenouncedMint && !renouncedMint) reasons.push('mint belum renounced');
    if (cfg.requireRenouncedFreeze && !renouncedFreeze) reasons.push('freeze belum renounced');
    if (top10HolderRate > cfg.maxTop10HolderRate) reasons.push(`top 10 holder terlalu besar ${(top10HolderRate * 100).toFixed(1)}%`);
    if (buyTax > cfg.maxBuyTax) reasons.push(`buy tax ${buyTax}`);
    if (sellTax > cfg.maxSellTax) reasons.push(`sell tax ${sellTax}`);
    if (cfg.requireLaunchpadComplete && launchpadProgress > 0 && launchpadProgress < 1) reasons.push(`launchpad belum complete ${launchpadProgress}`);
    if (cfg.allowedLaunchpads.length && launchpadPlatform && !cfg.allowedLaunchpads.includes(launchpadPlatform)) reasons.push(`launchpad tidak diizinkan: ${launchpadPlatform}`);

    return {
      ok: reasons.length === 0,
      reason: reasons.length ? reasons.join(', ') : 'GMGN security passed',
      metrics: {
        isShowAlert,
        top10HolderRate,
        renouncedMint,
        renouncedFreeze,
        isHoneypot,
        buyTax,
        sellTax,
        launchpadPlatform,
        launchpadProgress
      }
    };
  }

  async validateToken(tokenAddress) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { ok: true, reason: 'GMGN disabled' };

    try {
      const payload = await this.getTokenSecurity(tokenAddress);
      if (payload?.code !== undefined && payload.code !== 0) {
        const reason = payload?.message || `GMGN code ${payload.code}`;
        activityLogger.log('GMGN_SECURITY_ERROR', { tokenAddress, reason, payload });
        return { ok: !cfg.rejectOnError, reason, payload };
      }

      const result = this.validateSecurityPayload(payload);
      activityLogger.log(result.ok ? 'GMGN_SECURITY_OK' : 'GMGN_SECURITY_REJECTED', {
        tokenAddress,
        reason: result.reason,
        metrics: result.metrics
      });
      return { ...result, payload };
    } catch (error) {
      const reason = error.response?.data?.message || error.response?.data?.error || error.message;
      activityLogger.log('GMGN_SECURITY_REQUEST_ERROR', { tokenAddress, reason });
      return { ok: !cfg.rejectOnError, reason: `GMGN error: ${reason}` };
    }
  }
}

module.exports = new GmgnService();
