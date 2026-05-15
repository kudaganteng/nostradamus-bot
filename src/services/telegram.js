require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

class TelegramService {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
        this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    async sendMessage(message) {
        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Gagal mengirim pesan Telegram:', error.message);
        }
    }

    async notifyDetection(tokenData) {
        const address = tokenData.baseToken.address;
        const message = `
🎯 *KOIN TERDETEKSI!*
━━━━━━━━━━━━━━━━━━
*Nama:* ${tokenData.baseToken.name}
*CA:* \`${address}\` 
*Liq:* $${tokenData.liquidity.usd}
*Change 5m:* ${tokenData.priceChange.m5}%

[DexScreener](${tokenData.url})
    `;
        await this.sendMessage(message);
    }

    async notifyTrade(type, data) {
        const sign = type === 'BUY' ? '🔵' : '🟢';
        
        if (type === 'SELL') {
            const storage = require('../utils/storage');
            const portfolio = storage.getPortfolio();
            const profitInSol = Number.isFinite(Number(data.netPnlSol))
                ? Number(data.netPnlSol)
                : (data.pnl / 100) * data.positionSize;
            const winRate = portfolio.tradeCount > 0
                ? ((portfolio.winCount / portfolio.tradeCount) * 100).toFixed(1)
                : '0.0';
            
            const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Quoted Entry:* $${data.quotedEntryPrice || data.entryPrice}
*Executed Entry:* $${data.entryPrice}
*Quoted Exit:* $${data.quotedExitPrice || data.exitPrice}
*Executed Exit:* $${data.exitPrice}
*Position Size:* ${data.positionSize} SOL
*Token Units:* ${Number(data.receivedTokenUnits || 0).toFixed(6)}
*Profit/Loss:* ${profitInSol >= 0 ? '+' : ''}${profitInSol.toFixed(6)} SOL
*Net PNL:* ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}%
*Market PNL:* ${Number(data.grossMarketPnlPercent || data.pnl).toFixed(2)}%
*Total Fees:* ${Number(data.totalFeeSol || 0).toFixed(6)} SOL
*Buy Slip:* ${data.buySlippageBps || 0} bps
*Sell Slip:* ${data.sellSlippageBps || 0} bps
*Failed Sell Fees:* ${Number(data.accumulatedFailedSellFeesSol || 0).toFixed(6)} SOL
*Reason:* ${data.reason}
*Duration:* ${this.formatDuration(data.openedAt, data.closedAt)}

━━━━━━━━━━━━━━━━━━
📊 *PORTFOLIO UPDATE*
━━━━━━━━━━━━━━━━━━
*Balance:* ${portfolio.currentBalance.toFixed(6)} SOL
*Total PNL:* ${portfolio.totalPnLPercent >= 0 ? '+' : ''}${portfolio.totalPnLPercent.toFixed(2)}%
*Trades:* ${portfolio.tradeCount} | ✅ ${portfolio.winCount} | ❌ ${portfolio.lossCount}
*Win Rate:* ${winRate}%
*Max Drawdown:* ${portfolio.maxDrawdown.toFixed(2)}%
            `;
            await this.sendMessage(message);
            return;
        }
        
        const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Quoted Price:* $${data.quotedPrice || data.price}
*Executed Price:* $${data.price}
*Fee:* ${Number(data.feeSol || 0).toFixed(6)} SOL
*Slippage:* ${data.slippageBps || 0} bps
*CA:* \`${data.address}\`
        `;
        await this.sendMessage(message);
    }
    
    formatDuration(openedAt, closedAt) {
        const start = new Date(openedAt);
        const end = new Date(closedAt);
        const diffMs = end - start;
        const diffSecs = Math.floor(diffMs / 1000);
        const mins = Math.floor(diffSecs / 60);
        const secs = diffSecs % 60;
        return `${mins}m ${secs}s`;
    }
}

module.exports = new TelegramService();
