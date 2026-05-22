require('dotenv').config();

const axios = require('axios');
const config = require('../../config.json');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

function toRawAmount(amount, decimals) {
    return Math.floor(Number(amount) * Math.pow(10, decimals)).toString();
}

function fromRawAmount(rawAmount, decimals) {
    return Number(rawAmount) / Math.pow(10, decimals);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimited(error) {
    const status = error?.response?.status;
    const message = String(error?.message || '').toLowerCase();
    return status === 429 || message.includes('429') || message.includes('rate limit');
}

function getJupiterHeaders() {
    const headers = {};
    const apiKey = process.env.JUPITER_API_KEY;
    if (apiKey) headers['x-api-key'] = apiKey;
    return headers;
}

function getExecutionConfig() {
    return {
        quoteEndpoint: config.jupiter?.quoteEndpoint || 'https://api.jup.ag/swap/v1/quote',
        slippageBps: config.jupiter?.slippageBps ?? 500,
        maxPriceImpactPct: config.jupiter?.maxPriceImpactPct ?? 5,
        maxEntryPriceImpactPct: config.jupiter?.maxEntryPriceImpactPct ?? config.jupiter?.maxPriceImpactPct ?? 5,
        maxExitPriceImpactPct: config.jupiter?.maxExitPriceImpactPct ?? config.jupiter?.maxPriceImpactPct ?? 5,
        requestMinIntervalMs: config.jupiter?.requestMinIntervalMs ?? 500,
        quoteRetryCount: config.jupiter?.quoteRetryCount ?? 2,
        quoteRetryDelayMs: config.jupiter?.quoteRetryDelayMs ?? 1500,
        sameSizeRetryOn429: config.jupiter?.sameSizeRetryOn429 ?? 1,
        sameSizeRetryDelayMs: config.jupiter?.sameSizeRetryDelayMs ?? 2500,
        sellSolOnly: config.jupiter?.sellSolOnly !== false,
        enableRoundTripValidation: config.jupiter?.enableRoundTripValidation ?? true,
        maxRoundTripLossPct: config.jupiter?.maxRoundTripLossPct ?? 5,
        minRoundTripOutSol: config.jupiter?.minRoundTripOutSol ?? 0,
        minPositionSizeSol: config.jupiter?.minPositionSizeSol ?? 0.03,
        positionSizeRetryMultipliers: config.jupiter?.positionSizeRetryMultipliers || [1, 0.75, 0.5, 0.25],
        estimatedSwapFeeSol: config.costs?.estimatedSwapFeeSol ?? 0,
        estimatedPriorityFeeSol: config.costs?.estimatedPriorityFeeSol ?? 0
    };
}

class PriceImpactError extends Error {
    constructor(message, priceImpactPct, maxPriceImpactPct) {
        super(message);
        this.name = 'PriceImpactError';
        this.priceImpactPct = priceImpactPct;
        this.maxPriceImpactPct = maxPriceImpactPct;
    }
}

class RoundTripLiquidityError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'RoundTripLiquidityError';
        this.details = details;
    }
}

class JupiterService {
    constructor() {
        this.lastRequestAt = 0;
    }

    async throttle() {
        const execConfig = getExecutionConfig();
        const elapsed = Date.now() - this.lastRequestAt;
        const waitMs = Math.max(0, execConfig.requestMinIntervalMs - elapsed);
        if (waitMs > 0) await sleep(waitMs);
        this.lastRequestAt = Date.now();
    }

    async getQuote(inputMint, outputMint, amountRaw, options = {}) {
        const execConfig = getExecutionConfig();
        const retryCount = Math.max(0, Number(options.retryCount ?? execConfig.quoteRetryCount));
        let lastError;

        for (let attempt = 0; attempt <= retryCount; attempt++) {
            try {
                await this.throttle();
                const response = await axios.get(execConfig.quoteEndpoint, {
                    timeout: 8000,
                    headers: getJupiterHeaders(),
                    params: {
                        inputMint,
                        outputMint,
                        amount: amountRaw,
                        slippageBps: options.slippageBps ?? execConfig.slippageBps,
                        onlyDirectRoutes: false
                    }
                });

                if (!response.data || !response.data.outAmount) throw new Error('Jupiter quote tidak mengembalikan outAmount.');

                const maxPriceImpactPct = options.maxPriceImpactPct ?? execConfig.maxPriceImpactPct;
                const priceImpactPct = Number(response.data.priceImpactPct || 0);
                if (Number.isFinite(priceImpactPct) && priceImpactPct > maxPriceImpactPct) {
                    throw new PriceImpactError(`Price impact Jupiter terlalu tinggi: ${priceImpactPct}% > ${maxPriceImpactPct}%`, priceImpactPct, maxPriceImpactPct);
                }

                return response.data;
            } catch (error) {
                lastError = error;
                const hit429 = isRateLimited(error);
                if (!hit429 || attempt >= retryCount) break;
                await sleep(execConfig.quoteRetryDelayMs * (attempt + 1));
            }
        }
        throw lastError;
    }

    estimateSwapCostSol() {
        const execConfig = getExecutionConfig();
        return execConfig.estimatedSwapFeeSol + execConfig.estimatedPriorityFeeSol;
    }

    async validateRoundTrip({ tokenMint, positionSizeSol, tokenDecimals, buyQuote }) {
        const execConfig = getExecutionConfig();
        if (!execConfig.enableRoundTripValidation) return { enabled: false, accepted: true };

        const sellQuote = await this.getQuote(tokenMint, SOL_MINT, buyQuote.outAmount, { maxPriceImpactPct: execConfig.maxExitPriceImpactPct });
        const roundTripOutSol = fromRawAmount(sellQuote.outAmount, SOL_DECIMALS);
        const estimatedFeesSol = this.estimateSwapCostSol() * 2;
        const netRoundTripOutSol = roundTripOutSol - estimatedFeesSol;
        const roundTripLossPct = ((positionSizeSol - netRoundTripOutSol) / positionSizeSol) * 100;
        const sellImpactPct = Number(sellQuote.priceImpactPct || 0);
        const tokenAmount = fromRawAmount(buyQuote.outAmount, tokenDecimals);

        const details = { accepted: true, positionSizeSol, tokenAmount, tokenOutRaw: buyQuote.outAmount, roundTripOutSol, netRoundTripOutSol, estimatedFeesSol, roundTripLossPct, sellImpactPct, maxRoundTripLossPct: execConfig.maxRoundTripLossPct, maxExitPriceImpactPct: execConfig.maxExitPriceImpactPct, minRoundTripOutSol: execConfig.minRoundTripOutSol, sellQuote };

        if (roundTripLossPct > execConfig.maxRoundTripLossPct) {
            details.accepted = false;
            throw new RoundTripLiquidityError(`Round-trip loss terlalu besar: ${roundTripLossPct.toFixed(2)}% > ${execConfig.maxRoundTripLossPct}%`, details);
        }

        if (execConfig.minRoundTripOutSol > 0 && roundTripOutSol < execConfig.minRoundTripOutSol) {
            details.accepted = false;
            throw new RoundTripLiquidityError(`Round-trip out SOL terlalu kecil: ${roundTripOutSol.toFixed(6)} < ${execConfig.minRoundTripOutSol}`, details);
        }

        return details;
    }

    buildBuyExecution(tokenMint, positionSizeSol, tokenDecimals, buyQuote, solUsdQuote, selectedMultiplier, quoteAttempts, roundTrip) {
        const tokenAmount = fromRawAmount(buyQuote.outAmount, tokenDecimals);
        const solUsdValue = fromRawAmount(solUsdQuote.outAmount, USDC_DECIMALS);
        if (!tokenAmount || !solUsdValue) throw new Error('Gagal menghitung harga entry dari quote Jupiter.');

        const entryPriceUsd = solUsdValue / tokenAmount;
        const estimatedFeeSol = this.estimateSwapCostSol();
        return { source: 'jupiter_quote', inputMint: SOL_MINT, outputMint: tokenMint, selectedMultiplier, requestedPositionSizeSol: config.trading?.positionSize, executedPositionSizeSol: positionSizeSol, solInRaw: buyQuote.inAmount, tokenOutRaw: buyQuote.outAmount, tokenAmount, solUsdValue, entryPriceUsd, priceImpactPct: Number(buyQuote.priceImpactPct || 0), estimatedFeeSol, roundTrip, quoteAttempts, quote: buyQuote };
    }

    async tryBuyExecutionForSize(tokenMint, candidatePositionSizeSol, tokenDecimals) {
        const execConfig = getExecutionConfig();
        const solInRaw = toRawAmount(candidatePositionSizeSol, SOL_DECIMALS);
        const buyQuote = await this.getQuote(SOL_MINT, tokenMint, solInRaw, { maxPriceImpactPct: execConfig.maxEntryPriceImpactPct });
        const roundTrip = await this.validateRoundTrip({ tokenMint, positionSizeSol: candidatePositionSizeSol, tokenDecimals, buyQuote });
        const solUsdQuote = await this.getQuote(SOL_MINT, USDC_MINT, solInRaw, { maxPriceImpactPct: 100 });
        return { buyQuote, roundTrip, solUsdQuote };
    }

    async getBuyExecution(tokenMint, requestedPositionSizeSol, tokenDecimals) {
        const execConfig = getExecutionConfig();
        const multipliers = execConfig.positionSizeRetryMultipliers;
        const quoteAttempts = [];

        for (const multiplier of multipliers) {
            const candidatePositionSizeSol = Number((requestedPositionSizeSol * multiplier).toFixed(9));
            if (candidatePositionSizeSol < execConfig.minPositionSizeSol) {
                quoteAttempts.push({ multiplier, positionSizeSol: candidatePositionSizeSol, skipped: true, reason: `Di bawah minPositionSizeSol ${execConfig.minPositionSizeSol}` });
                continue;
            }

            let lastRateLimitError = null;
            const sameSizeAttempts = 1 + Math.max(0, Number(execConfig.sameSizeRetryOn429));
            for (let sameSizeAttempt = 1; sameSizeAttempt <= sameSizeAttempts; sameSizeAttempt++) {
                try {
                    const { buyQuote, roundTrip, solUsdQuote } = await this.tryBuyExecutionForSize(tokenMint, candidatePositionSizeSol, tokenDecimals);
                    quoteAttempts.push({ multiplier, positionSizeSol: candidatePositionSizeSol, sameSizeAttempt, priceImpactPct: Number(buyQuote.priceImpactPct || 0), roundTripLossPct: roundTrip.roundTripLossPct, roundTripOutSol: roundTrip.roundTripOutSol, sellImpactPct: roundTrip.sellImpactPct, accepted: true });
                    return this.buildBuyExecution(tokenMint, candidatePositionSizeSol, tokenDecimals, buyQuote, solUsdQuote, multiplier, quoteAttempts, roundTrip);
                } catch (error) {
                    if (isRateLimited(error) && sameSizeAttempt < sameSizeAttempts) {
                        lastRateLimitError = error;
                        quoteAttempts.push({ multiplier, positionSizeSol: candidatePositionSizeSol, sameSizeAttempt, rejected: true, retrySameSize: true, reason: error.message });
                        await sleep(execConfig.sameSizeRetryDelayMs * sameSizeAttempt);
                        continue;
                    }

                    quoteAttempts.push({ multiplier, positionSizeSol: candidatePositionSizeSol, sameSizeAttempt, rejected: true, priceImpactPct: error.priceImpactPct, roundTripLossPct: error.details?.roundTripLossPct, roundTripOutSol: error.details?.roundTripOutSol, sellImpactPct: error.details?.sellImpactPct, rateLimited: isRateLimited(error), reason: error.message });
                    if (isRateLimited(error)) lastRateLimitError = error;
                    break;
                }
            }

            if (lastRateLimitError) {
                await sleep(execConfig.sameSizeRetryDelayMs);
            }
        }

        throw new Error(`Semua ukuran entry ditolak oleh liquidity/price impact guard. Attempts: ${JSON.stringify(quoteAttempts)}`);
    }

    async getSellSolExecution(tokenMint, tokenAmountRaw, tokenDecimals) {
        const execConfig = getExecutionConfig();
        const sellQuote = await this.getQuote(tokenMint, SOL_MINT, tokenAmountRaw, { maxPriceImpactPct: execConfig.maxExitPriceImpactPct });
        const tokenAmount = fromRawAmount(tokenAmountRaw, tokenDecimals);
        const exitSolAmount = fromRawAmount(sellQuote.outAmount, SOL_DECIMALS);
        const estimatedFeeSol = this.estimateSwapCostSol();
        if (!exitSolAmount) throw new Error('Gagal menghitung SOL exit dari quote Jupiter.');
        return { source: 'jupiter_quote_sol_only', inputMint: tokenMint, outputMint: SOL_MINT, tokenInRaw: tokenAmountRaw, solOutRaw: sellQuote.outAmount, tokenAmount, exitSolAmount, exitUsdValue: 0, exitPriceUsd: 0, priceImpactPct: Number(sellQuote.priceImpactPct || 0), estimatedFeeSol, quote: sellQuote };
    }

    async getSellExecution(tokenMint, tokenAmountRaw, tokenDecimals, options = {}) {
        const execConfig = getExecutionConfig();
        if (options.solOnly === true || execConfig.sellSolOnly === true) return this.getSellSolExecution(tokenMint, tokenAmountRaw, tokenDecimals);

        const sellQuote = await this.getQuote(tokenMint, SOL_MINT, tokenAmountRaw, { maxPriceImpactPct: execConfig.maxExitPriceImpactPct });
        const tokenUsdQuote = await this.getQuote(tokenMint, USDC_MINT, tokenAmountRaw, { maxPriceImpactPct: 100 });
        const tokenAmount = fromRawAmount(tokenAmountRaw, tokenDecimals);
        const exitSolAmount = fromRawAmount(sellQuote.outAmount, SOL_DECIMALS);
        const exitUsdValue = fromRawAmount(tokenUsdQuote.outAmount, USDC_DECIMALS);
        const exitPriceUsd = tokenAmount > 0 ? exitUsdValue / tokenAmount : 0;
        const estimatedFeeSol = this.estimateSwapCostSol();
        if (!exitSolAmount) throw new Error('Gagal menghitung harga exit dari quote Jupiter.');
        return { source: 'jupiter_quote', inputMint: tokenMint, outputMint: SOL_MINT, tokenInRaw: tokenAmountRaw, solOutRaw: sellQuote.outAmount, tokenAmount, exitSolAmount, exitUsdValue, exitPriceUsd, priceImpactPct: Number(sellQuote.priceImpactPct || 0), estimatedFeeSol, quote: sellQuote };
    }
}

module.exports = new JupiterService();
module.exports.SOL_MINT = SOL_MINT;
module.exports.USDC_MINT = USDC_MINT;
module.exports.PriceImpactError = PriceImpactError;
module.exports.RoundTripLiquidityError = RoundTripLiquidityError;
