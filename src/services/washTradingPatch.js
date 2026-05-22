const axios = require('axios');
const chalk = require('chalk');
const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');
const applySolPnlPatch = require('./solPnlPatch');
const applyProfitLockPatch = require('./profitLockPatch');
const applyRiskGuardPatch = require('./riskGuardPatch');
const applyPreEntryStabilityPatch = require('./preEntryStabilityPatch');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getWashConfig() {
  const w = config.washTrading || {};
  return {
    enabled: w.enabled !== false,
    failClosed: w.failClosed === true,
    requireUniqueBuyerData: w.requireUniqueBuyerData === true,
    maxTransactionsPerBuyer: n(w.maxTransactionsPerBuyer, 20),
    minUniqueBuyerRatio: n(w.minUniqueBuyerRatio, 0.12),
    minAverageTransactionUsd: n(w.minAverageTransactionUsd, 2),
    minTransactionsForLowAverageCheck: n(w.minTransactionsForLowAverageCheck, 8),
    minTransactionsForBotCheck: n(w.minTransactionsForBotCheck, 12),
    fakeMomentumMinVolume5mUsd: n(w.fakeMomentumMinVolume5mUsd, 1000),
    fakeMomentumMaxPriceChange5m: n(w.fakeMomentumMaxPriceChange5m, 1),
    fakeMomentumMinTransactions5m: n(w.fakeMomentumMinTransactions5m, 25)
  };
}

function readVolume5m(attributes) {
  const candidates = [attributes.volume_usd?.m5, attributes.volume_usd?.h24?.m5, attributes.volume?.m5, attributes.volume_m5_usd, attributes.volume_usd_m5, attributes.volume_5m_usd, attributes.volume_usd];
  for (const value of candidates) {
    const parsed = n(value, NaN);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function readTxns5m(attributes) {
  const buys = n(attributes.txns?.m5?.buys ?? attributes.transactions?.m5?.buys ?? attributes.buys_m5 ?? attributes.buy_transactions_m5, 0);
  const sells = n(attributes.txns?.m5?.sells ?? attributes.transactions?.m5?.sells ?? attributes.sells_m5 ?? attributes.sell_transactions_m5, 0);
  const totalFallback = n(attributes.transactions_5m ?? attributes.txns_m5 ?? attributes.transaction_count_m5, buys + sells);
  const total = buys + sells > 0 ? buys + sells : totalFallback;
  return { buys, sells, total };
}

function readUniqueBuyers(attributes) {
  const candidates = [attributes.unique_buyers_m5, attributes.unique_buyers?.m5, attributes.unique_traders_m5, attributes.unique_traders?.m5, attributes.unique_wallets_m5, attributes.unique_wallets?.m5];
  for (const value of candidates) {
    const parsed = n(value, NaN);
    if (Number.isFinite(parsed) && parsed > 0) return { available: true, value: parsed };
  }
  return { available: false, value: 0 };
}

function readPriceChange5m(attributes, fallbackPair) {
  const candidates = [attributes.price_change_percentage?.m5, attributes.price_change?.m5, attributes.price_change_m5, fallbackPair?.priceChange?.m5];
  for (const value of candidates) {
    const parsed = n(value, NaN);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function applyWashTradingPatch(engine) {
  if (!engine) return engine;
  applySolPnlPatch(engine);
  applyProfitLockPatch(engine);
  applyRiskGuardPatch(engine);
  applyPreEntryStabilityPatch(engine);
  if (engine.__washTradingPatchApplied) return engine;

  engine.checkWashTrading = async function patchedCheckWashTrading(tokenAddress, pairAddress, pairSnapshot = null) {
    const w = getWashConfig();
    if (!w.enabled) return false;

    try {
      console.log(chalk.cyan(`\n[Wash Trading Check] Menganalisis aktivitas trading untuk ${tokenAddress}...`));
      const geckoUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}`;
      const response = await axios.get(geckoUrl, { headers: { Accept: 'application/json' }, timeout: 8000 });

      if (!response.data || !response.data.data) {
        activityLogger.log('WASH_TRADING_UNKNOWN', { token: tokenAddress, reason: 'missing_gecko_data' });
        console.log(chalk.yellow('[Wash Trading Check] Data GeckoTerminal tidak ada.'));
        return w.failClosed;
      }

      const attributes = response.data.data.attributes || {};
      const txns = readTxns5m(attributes);
      const volume5mUsd = readVolume5m(attributes);
      const uniqueBuyers = readUniqueBuyers(attributes);
      const priceChange5m = readPriceChange5m(attributes, pairSnapshot);
      const avgTxUsd = txns.total > 0 ? volume5mUsd / txns.total : 0;
      const txPerBuyer = uniqueBuyers.available && uniqueBuyers.value > 0 ? txns.total / uniqueBuyers.value : null;
      const uniqueBuyerRatio = uniqueBuyers.available && txns.total > 0 ? uniqueBuyers.value / txns.total : null;

      console.log(chalk.gray(`   Tx 5m: ${txns.total} | Buys/Sells: ${txns.buys}/${txns.sells}`));
      console.log(chalk.gray(`   Volume 5m: $${volume5mUsd.toFixed(2)} | Avg/Tx: $${avgTxUsd.toFixed(2)}`));
      console.log(chalk.gray(`   Unique buyers: ${uniqueBuyers.available ? uniqueBuyers.value : 'N/A'} | PriceChange5m: ${priceChange5m.toFixed(2)}%`));

      if (w.requireUniqueBuyerData && !uniqueBuyers.available) {
        activityLogger.log('WASH_TRADING_UNKNOWN', { token: tokenAddress, reason: 'missing_unique_buyer_data', txns, volume5mUsd });
        return w.failClosed;
      }

      if (avgTxUsd > 0 && avgTxUsd < w.minAverageTransactionUsd && txns.total >= w.minTransactionsForLowAverageCheck) {
        activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'low_average_tx_usd', avgTxUsd, txns, volume5mUsd });
        return true;
      }

      if (uniqueBuyers.available && txPerBuyer !== null && txPerBuyer > w.maxTransactionsPerBuyer && txns.total >= w.minTransactionsForBotCheck) {
        activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'high_transactions_per_buyer', txPerBuyer, uniqueBuyers: uniqueBuyers.value, txns });
        return true;
      }

      if (uniqueBuyers.available && uniqueBuyerRatio !== null && uniqueBuyerRatio < w.minUniqueBuyerRatio && txns.total >= w.minTransactionsForBotCheck) {
        activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'low_unique_buyer_ratio', uniqueBuyerRatio, uniqueBuyers: uniqueBuyers.value, txns });
        return true;
      }

      if (volume5mUsd >= w.fakeMomentumMinVolume5mUsd && txns.total >= w.fakeMomentumMinTransactions5m && priceChange5m <= w.fakeMomentumMaxPriceChange5m) {
        activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'fake_momentum_volume_without_price', volume5mUsd, txns, priceChange5m });
        return true;
      }

      activityLogger.log('WASH_TRADING_CLEAN', { token: tokenAddress, txns, volume5mUsd, avgTxUsd, uniqueBuyers: uniqueBuyers.available ? uniqueBuyers.value : null, uniqueBuyerRatio, txPerBuyer, priceChange5m });
      return false;
    } catch (error) {
      activityLogger.log('WASH_TRADING_CHECK_ERROR', { token: tokenAddress, error: error.message, failClosed: w.failClosed });
      console.log(chalk.yellow(`[Wash Trading Check] Error: ${error.message}`));
      return w.failClosed;
    }
  };

  engine.__washTradingPatchApplied = true;
  return engine;
}

module.exports = applyWashTradingPatch;
