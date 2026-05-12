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
        
        // Untuk SELL/CLOSE, tambahkan detail trade dan portfolio
        if (type === 'SELL') {
            const storage = require('../utils/storage');
            const portfolio = storage.getPortfolio();
            
            const profitInSol = (data.pnl / 100) * data.positionSize;
            const exitValue = data.positionSize + profitInSol;
            
            const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Entry Price:* $${data.entryPrice}
*Exit Price:* $${data.exitPrice}
*Position Size:* ${data.positionSize} SOL
*Profit/Loss:* ${profitInSol >= 0 ? '+' : ''}${profitInSol.toFixed(6)} SOL
*PNL:* ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}%
*Reason:* ${data.reason}
*Duration:* ${this.formatDuration(data.openedAt, data.closedAt)}

━━━━━━━━━━━━━━━━━━
📊 *PORTFOLIO UPDATE*
━━━━━━━━━━━━━━━━━━
*Balance:* ${portfolio.currentBalance.toFixed(6)} SOL
*Total PNL:* ${portfolio.totalPnLPercent >= 0 ? '+' : ''}${portfolio.totalPnLPercent.toFixed(2)}%
*Trades:* ${portfolio.tradeCount} | ✅ ${portfolio.winCount} | ❌ ${portfolio.lossCount}
*Win Rate:* ${((portfolio.winCount / portfolio.tradeCount) * 100).toFixed(1)}%
*Max Drawdown:* ${portfolio.maxDrawdown.toFixed(2)}%
            `;
            await this.sendMessage(message);
            return;
        }
        
        // Untuk BUY, tetap gunakan format sederhana
        const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Price:* ${data.price}
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
