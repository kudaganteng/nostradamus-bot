const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const LOG_FILE = path.join(process.cwd(), 'botActivity.json');
let writeLock = false;
let writeQueue = [];

const ActivityLogger = {
    init() {
        try {
            if (!fs.existsSync(LOG_FILE)) {
                fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2), 'utf8');
                console.log(chalk.blue("✓ File botActivity.json berhasil dibuat."));
            } else {
                // Validasi file existing
                try {
                    const data = fs.readFileSync(LOG_FILE, 'utf8');
                    if (data.trim()) {
                        JSON.parse(data);
                    }
                } catch (parseErr) {
                    console.warn(chalk.yellow("⚠ File log corrupt, membuat backup dan reset..."));
                    const backupFile = `${LOG_FILE}.backup.${Date.now()}`;
                    fs.renameSync(LOG_FILE, backupFile);
                    fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2), 'utf8');
                    console.log(chalk.blue(`✓ Backup: ${backupFile}`));
                }
            }
            // Catat bahwa bot baru saja dinyalakan
            this.log("BOT_STARTED", { message: "Scanner dan Logger online." });
        } catch (err) {
            console.error(chalk.red("Gagal membuat botActivity.json:"), err.message);
        }
    },

    log(action, details = {}) {
        // Masukkan ke queue jika ada write lock
        if (writeLock) {
            writeQueue.push({ action, details });
            return;
        }

        this._processLog(action, details);
    },

    _processLog(action, details) {
        writeLock = true;
        
        try {
            let logs = [];
            
            if (fs.existsSync(LOG_FILE)) {
                const fileData = fs.readFileSync(LOG_FILE, 'utf8');
                if (fileData && fileData.trim()) {
                    try {
                        logs = JSON.parse(fileData);
                        if (!Array.isArray(logs)) {
                            logs = [];
                        }
                    } catch (parseErr) {
                        console.warn(chalk.yellow("⚠ Log file corrupt, resetting..."));
                        logs = [];
                    }
                }
            }

            const newLog = {
                timestamp: new Date().toISOString(),
                action: action,
                ...details
            };

            logs.unshift(newLog);

            // Batasi maksimal 200 aktivitas agar file tidak membengkak
            const trimmedLogs = logs.slice(0, 200);
            
            // Atomic write dengan temporary file
            const tempFile = `${LOG_FILE}.tmp.${Date.now()}`;
            fs.writeFileSync(tempFile, JSON.stringify(trimmedLogs, null, 2), 'utf8');
            fs.renameSync(tempFile, LOG_FILE);
            
        } catch (err) {
            console.error(chalk.red("Gagal menulis log aktivitas:"), err.message);
        } finally {
            writeLock = false;
            
            // Process queue jika ada
            if (writeQueue.length > 0) {
                const next = writeQueue.shift();
                setTimeout(() => this._processLog(next.action, next.details), 10);
            }
        }
    }
};

module.exports = ActivityLogger;