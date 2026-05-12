const scanner = require('./services/scanner');
const engine = require('./services/engine');
const activityLogger = require('./utils/activityLogger');
const storage = require('./utils/storage');
const chalk = require('chalk');

let isObserving = false;
let scanCounter = 0;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startScanLoop() {
    while (true) {
        const sleepMs = engine.currentPosition || isObserving ? 5000 : 3000;

        if (!engine.currentPosition && !isObserving) {
            try {
                scanCounter++;
                const dots = '.'.repeat(scanCounter % 4);
                process.stdout.write(chalk.gray(`\r[Scanner] Memantau market Solana${dots.padEnd(3)} `));

                const target = await scanner.findOpportunities();

                if (target) {
                    console.log(chalk.bgGreen.black.bold(`\n\n🎯 TARGET MATCH: ${target.baseToken.symbol} `));

                    isObserving = true;
                    const isConfirmed = await engine.observeAndConfirm(target);
                    isObserving = false;

                    if (isConfirmed) {
                        await engine.openPosition(target);
                    } else {
                        console.log(chalk.gray(`[Info] Memasukkan ${target.baseToken.symbol} ke cooldown 3 menit karena gagal Breakout.`));
                        const state = storage.getState();
                        state.tokenStats[target.baseToken.address] = state.tokenStats[target.baseToken.address] || { slCount: 0, cooldownUntil: 0, blacklisted: false };
                        state.tokenStats[target.baseToken.address].cooldownUntil = Date.now() + (3 * 60 * 1000);
                        storage.saveState(state);
                    }
                }
            } catch (error) {
                console.error(chalk.red("\n[Loop Error]:"), error.message);
                isObserving = false;
            }
        }

        await delay(sleepMs);
    }
}

console.log(chalk.cyan.bold("====================================="));
console.log(chalk.cyan.bold("  SOLANA SCALPER (SNIPER MODE v3)    "));
console.log(chalk.cyan.bold("====================================="));

// PANGGIL INISIALISASI DI SINI AGAR FILE JSON PASTI ADA
storage.init();
activityLogger.init();

startScanLoop();