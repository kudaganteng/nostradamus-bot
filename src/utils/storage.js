const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../../config.json');

const TRADES_FILE = path.join(process.cwd(), 'paperTrades.json');
const PORTFOLIO_FILE = path.join(process.cwd(), 'portfolio.json');
const STATE_FILE = path.join(process.cwd(), 'botState.json');
const POSITION_FILE = path.join(process.cwd(), 'activePosition.json');
const RUNTIME_SETTINGS_FILE = path.join(process.cwd(), 'runtimeSettings.json');

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
        console.error(chalk.red(`Gagal membaca file ${filePath}:`), err.message);
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getInitialPaperBalance() {
    const balance = Number(config.trading?.paperBalance);
    return Number.isFinite(balance) && balance > 0 ? balance : 1.0;
}

function createInitialPortfolio() {
    const initialBalance = getInitialPaperBalance();

    return {
        startBalance: initialBalance,
        currentBalance: initialBalance,
        peakBalance: initialBalance,
        maxDrawdown: 0,
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        totalPnLPercent: 0
    };
}

function createInitialRuntimeSettings() {
    return {
        targetProfitPercent: Number(config.trading?.targetProfitPercent || 5),
        stopLossPercent: Number(config.trading?.stopLossPercent || 7),
        trailingStartPercent: Number(config.trading?.trailingStartPercent || 7),
        trailingStopPercent: Number(config.trading?.trailingStopPercent || 3),
        updatedAt: null,
        updatedBy: 'config'
    };
}

function normalizeRuntimeSettings(settings = {}) {
    const base = createInitialRuntimeSettings();
    return {
        ...base,
        ...settings,
        targetProfitPercent: Number.isFinite(Number(settings.targetProfitPercent)) ? Number(settings.targetProfitPercent) : base.targetProfitPercent,
        stopLossPercent: Number.isFinite(Number(settings.stopLossPercent)) ? Number(settings.stopLossPercent) : base.stopLossPercent,
        trailingStartPercent: Number.isFinite(Number(settings.trailingStartPercent)) ? Number(settings.trailingStartPercent) : base.trailingStartPercent,
        trailingStopPercent: Number.isFinite(Number(settings.trailingStopPercent)) ? Number(settings.trailingStopPercent) : base.trailingStopPercent
    };
}

function shouldSyncEmptyPortfolio(portfolio) {
    if (!portfolio) return true;
    const hasNoTradeHistory = Number(portfolio.tradeCount || 0) === 0;
    const configuredBalance = getInitialPaperBalance();

    return hasNoTradeHistory && Number(portfolio.startBalance) !== configuredBalance;
}

const Storage = {
    init() {
        try {
            if (!fs.existsSync(TRADES_FILE)) writeJson(TRADES_FILE, []);
            if (!fs.existsSync(RUNTIME_SETTINGS_FILE)) writeJson(RUNTIME_SETTINGS_FILE, createInitialRuntimeSettings());
            if (!fs.existsSync(PORTFOLIO_FILE)) {
                writeJson(PORTFOLIO_FILE, createInitialPortfolio());
            } else {
                const portfolio = readJson(PORTFOLIO_FILE, null);

                if (shouldSyncEmptyPortfolio(portfolio)) {
                    writeJson(PORTFOLIO_FILE, createInitialPortfolio());
                }
            }

            if (!fs.existsSync(STATE_FILE)) {
                writeJson(STATE_FILE, {
                    globalPauseUntil: 0,
                    consecutiveLosses: 0,
                    tokenStats: {}
                });
            }
        } catch (err) {
            console.error(chalk.red('Gagal inisialisasi storage:'), err.message);
        }
    },

    getState() {
        return readJson(STATE_FILE, {
            globalPauseUntil: 0,
            consecutiveLosses: 0,
            tokenStats: {}
        });
    },

    saveState(state) {
        writeJson(STATE_FILE, state);
    },

    getRuntimeSettings() {
        return normalizeRuntimeSettings(readJson(RUNTIME_SETTINGS_FILE, createInitialRuntimeSettings()));
    },

    saveRuntimeSettings(settings, updatedBy = 'telegram') {
        const current = this.getRuntimeSettings();
        const next = normalizeRuntimeSettings({
            ...current,
            ...settings,
            updatedAt: new Date().toISOString(),
            updatedBy
        });
        writeJson(RUNTIME_SETTINGS_FILE, next);
        return next;
    },

    getPortfolio() {
        return readJson(PORTFOLIO_FILE, createInitialPortfolio());
    },

    getTrades() {
        return readJson(TRADES_FILE, []);
    },

    getRecentTrades(limit = 10) {
        const trades = this.getTrades();
        return trades.slice(Math.max(0, trades.length - limit));
    },

    getTradesByAddress(address) {
        if (!address) return [];
        return this.getTrades().filter(trade => trade.address === address);
    },

    saveTrade(trade) {
        const trades = readJson(TRADES_FILE, []);
        trades.push(trade);
        writeJson(TRADES_FILE, trades);

        const portfolio = this.getPortfolio();
        const profitInSol = Number.isFinite(Number(trade.netPnlSol))
            ? Number(trade.netPnlSol)
            : (Number(trade.pnl) / 100) * Number(trade.positionSize);

        portfolio.currentBalance += profitInSol;
        portfolio.tradeCount += 1;
        if (profitInSol > 0) portfolio.winCount += 1;
        else portfolio.lossCount += 1;

        if (portfolio.currentBalance > portfolio.peakBalance) {
            portfolio.peakBalance = portfolio.currentBalance;
        }

        const currentDD = ((portfolio.peakBalance - portfolio.currentBalance) / portfolio.peakBalance) * 100;
        if (currentDD > portfolio.maxDrawdown) portfolio.maxDrawdown = currentDD;
        portfolio.totalPnLPercent = ((portfolio.currentBalance - portfolio.startBalance) / portfolio.startBalance) * 100;

        writeJson(PORTFOLIO_FILE, portfolio);
        
        if (fs.existsSync(POSITION_FILE)) {
            fs.unlinkSync(POSITION_FILE);
        }
        
        return portfolio;
    },

    saveActivePosition(position) {
        try {
            writeJson(POSITION_FILE, position);
            console.log(chalk.green('[Storage] Posisi aktif disimpan untuk recovery.'));
        } catch (err) {
            console.error(chalk.red('Gagal menyimpan posisi aktif:'), err.message);
        }
    },

    loadActivePosition() {
        try {
            const position = readJson(POSITION_FILE, null);
            if (position) {
                console.log(chalk.green('[Storage] Posisi aktif ditemukan dan dimuat untuk recovery.'));
                console.log(chalk.cyan(`   Symbol: ${position.symbol}, Entry: $${position.entryPrice.toFixed(6)}`));
            }
            return position;
        } catch (err) {
            console.error(chalk.red('Gagal memuat posisi aktif:'), err.message);
            return null;
        }
    }
};

module.exports = Storage;
