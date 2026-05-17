const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class JupiterMarketService {
  constructor() {
    this.decimalsCache = new Map([[SOL_MINT, SOL_DECIMALS]]);
  }

  bindConnection(connection) {
    this.connection = connection;
    return this;
  }

  getConfig() {
    const pm = config.priceMonitoring || {};
    return {
      quoteUrl: pm.jupiterQuoteUrl || 'https://api.jup.ag/swap/v1/quote',
      slippageBps: Math.max(1, n(pm.jupiterSlippageBps, 100)),
      onlyDirectRoutes: pm.jupiterOnlyDirectRoutes === true,
      timeoutMs: Math.max(300, n(pm.timeoutMs, 3000)),
      assumedSolUsd: Math.max(1, n(pm.assumedSolUsd, 150)),
      probeSizeSol: Math.max(0.001, n(pm.jupiterProbeSizeSol, config.trading?.positionSize || 0.2)),
      maxPriceImpactPct: Math.max(0, n(pm.maxJupiterPriceImpactPct, 0.05))
    };
  }

  getHeaders() {
    const headers = { Accept: 'application/json' };
    if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
    return headers;
  }

  async getTokenDecimals(mint) {
    if (this.decimalsCache.has(mint)) return this.decimalsCache.get(mint);
    if (!this.connection) return 6;

    try {
      const account = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const decimals = n(account.value?.data?.parsed?.info?.decimals, 6);
      this.decimalsCache.set(mint, decimals);
      return decimals;
    } catch (error) {
      activityLogger.log('TOKEN_DECIMALS_ERROR', { mint, error: error.message });
      return 6;
    }
  }

  async quote(params, timeoutMs = null) {
    const cfg = this.getConfig();
    const response = await axios.get(cfg.quoteUrl, {
      params: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: String(params.amount),
        slippageBps: String(params.slippageBps ?? cfg.slippageBps),
        onlyDirectRoutes: String(params.onlyDirectRoutes ?? cfg.onlyDirectRoutes)
      },
      headers: this.getHeaders(),
      timeout: timeoutMs || cfg.timeoutMs
    });
    return response.data;
  }

  async getBuyQuote(tokenAddress, sizeSol = null, timeoutMs = null) {
    const cfg = this.getConfig();
    const inputSol = Math.max(0, n(sizeSol, cfg.probeSizeSol));
    const amount = Math.floor(inputSol * Math.pow(10, SOL_DECIMALS));
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const raw = await this.quote({ inputMint: SOL_MINT, outputMint: tokenAddress, amount }, timeoutMs);
    const decimals = await this.getTokenDecimals(tokenAddress);
    const tokenUnits = n(raw?.outAmount, 0) / Math.pow(10, decimals);
    const impliedPriceUsd = tokenUnits > 0 ? (inputSol * cfg.assumedSolUsd) / tokenUnits : 0;

    if (!Number.isFinite(impliedPriceUsd) || impliedPriceUsd <= 0) return null;
    return {
      side: 'buy',
      inputSol,
      tokenUnits,
      impliedPriceUsd,
      priceImpactPct: n(raw?.priceImpactPct, 0),
      raw
    };
  }

  async getSellQuote(tokenAddress, tokenUnits, timeoutMs = null) {
    const decimals = await this.getTokenDecimals(tokenAddress);
    const amount = Math.floor(n(tokenUnits, 0) * Math.pow(10, decimals));
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const cfg = this.getConfig();
    const raw = await this.quote({ inputMint: tokenAddress, outputMint: SOL_MINT, amount }, timeoutMs);
    const outSol = n(raw?.outAmount, 0) / Math.pow(10, SOL_DECIMALS);
    const impliedPriceUsd = tokenUnits > 0 ? (outSol / tokenUnits) * cfg.assumedSolUsd : 0;

    if (!Number.isFinite(impliedPriceUsd) || impliedPriceUsd <= 0) return null;
    return {
      side: 'sell',
      outSol,
      tokenUnits,
      impliedPriceUsd,
      priceImpactPct: n(raw?.priceImpactPct, 0),
      raw
    };
  }

  async getProbePrice(tokenAddress, sizeSol = null, timeoutMs = null) {
    try {
      return await this.getBuyQuote(tokenAddress, sizeSol, timeoutMs);
    } catch (error) {
      activityLogger.log('JUPITER_PROBE_QUOTE_ERROR', { tokenAddress, error: error.response?.data?.error || error.message });
      return null;
    }
  }
}

module.exports = new JupiterMarketService();
module.exports.SOL_MINT = SOL_MINT;
module.exports.SOL_DECIMALS = SOL_DECIMALS;
