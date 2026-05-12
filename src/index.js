const scanner = require('./services/scanner');
const axios = require('axios');
const engine = require('./services/engine');
const activityLogger = require('./utils/activityLogger');
const storage = require('./utils/storage'); // Wajib di-import
const chalk = require('chalk');

let isObserving = false; 
let scanCounter = 0; // Untuk animasi loading

async function startScanLoop() {
    // Jika sedang trading atau observasi, jeda scanner
    if (engine.currentPosition || isObserving) {
        setTimeout(startScanLoop, 5000);
        return;
    }

    try {
        // --- INDIKATOR BOT BERJALAN ---
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
                
                // Tambahkan cooldown manual via storage
                let state = storage.getState();
                if (!state.tokenStats[target.baseToken.address]) {
                    state.tokenStats[target.baseToken.address] = { slCount: 0, cooldownUntil: 0, blacklisted: false };
                }
                state.tokenStats[target.baseToken.address].cooldownUntil = Date.now() + (3 * 60 * 1000);
                storage.saveState(state);
            }
        } 
    } catch (error) {
        console.error(chalk.red("\n[Loop Error]:"), error.message);
        isObserving = false;
    } finally {
        // Terus berulang setiap 3 detik
        setTimeout(startScanLoop, 3000);
    }
}

console.log(chalk.cyan.bold("====================================="));
console.log(chalk.cyan.bold("  SOLANA SCALPER (SNIPER MODE v3)    "));
console.log(chalk.cyan.bold("====================================="));

// PANGGIL INISIALISASI DI SINI AGAR FILE JSON PASTI ADA
storage.init();
activityLogger.init();

startScanLoop();