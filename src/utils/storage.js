const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const TRADES_FILE = path.join(process.cwd(), 'paperTrades.json');
const PORTFOLIO_FILE = path.join(process.cwd(), 'portfolio.json');
const STATE_FILE = path.join(process.cwd(), 'botState.json'); // File baru untuk tracking cooldown

const Storage = {
    init() {
        try {
            if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, JSON.stringify([], null, 2));
            if (!fs.existsSync(PORTFOLIO_FILE)) {
                const initialPortfolio = {
                    startBalance: 1.0, currentBalance: 1.0, peakBalance: 1.0, maxDrawdown: 0,
                    tradeCount: 0, winCount: 0, lossCount: 0, totalPnLPercent: 0
                };
                fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(initialPortfolio, null, 2));
            }
            // Inisialisasi State Bot
            if (!fs.existsSync(STATE_FILE)) {
                const initialState = {
                    globalPauseUntil: 0,
                    consecutiveLosses: 0,
                    tokenStats: {} // Format: { "CA": { slCount: 0, cooldownUntil: 0, blacklisted: false } }
                };
                fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2));
            }
        } catch (err) {
            console.error(chalk.red("Gagal inisialisasi storage:"), err.message);
        }
    },

    getState() {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    },

    saveState(state) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    },

    getPortfolio() {
        return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    },

    saveTrade(trade) {
        const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
        trades.push(trade);
        fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');

        let portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
        const profitInSol = (trade.pnl / 100) * trade.positionSize; // Akan menggunakan 0.2 SOL

        portfolio.currentBalance += profitInSol;
        portfolio.tradeCount += 1;
        if (trade.pnl > 0) portfolio.winCount += 1; else portfolio.lossCount += 1;

        if (portfolio.currentBalance > portfolio.peakBalance) portfolio.peakBalance = portfolio.currentBalance;
        const currentDD = ((portfolio.peakBalance - portfolio.currentBalance) / portfolio.peakBalance) * 100;
        if (currentDD > portfolio.maxDrawdown) portfolio.maxDrawdown = currentDD;
        portfolio.totalPnLPercent = ((portfolio.currentBalance - portfolio.startBalance) / portfolio.startBalance) * 100;

        fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2), 'utf8');
        return portfolio;
    }
};

module.exports = Storage;