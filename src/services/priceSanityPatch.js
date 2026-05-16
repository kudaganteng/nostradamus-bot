const config = require('../../config.json');
const activityLogger = require('../utils/activityLogger');

function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getSanityConfig() {
    const pm = config.priceMonitoring || {};
    return {
        enabled: pm.useJupiterSanityCheck === true,
        maxDivergencePercent: Math.max(0, safeNumber(pm.maxJupiterDexDivergencePercent, 25)),
        maxPriceImpactPct: Math.max(0, safeNumber(pm.maxJupiterPriceImpactPct, 0.05)),
        extremePnlPercent: Math.max(0, safeNumber(pm.ignoreJupiterExtremePnlPercent, 40)),
        extremePnlSeconds: Math.max(0, safeNumber(pm.ignoreJupiterExtremePnlSeconds, 30))
    };
}

function getElapsedSeconds(engine) {
    if (typeof engine.getElapsedSeconds === 'function') return engine.getElapsedSeconds();
    if (!engine.currentPosition?.openedAt) return 0;
    return (Date.now() - new Date(engine.currentPosition.openedAt).getTime()) / 1000;
}

function validateJupiterQuote(engine, dexPrice, jupiterPrice) {
    const sanity = getSanityConfig();
    const position = engine.currentPosition;
    if (!sanity.enabled) return { ok: false, reason: 'sanity_disabled' };
    if (!position) return { ok: false, reason: 'missing_position' };
    if (!Number.isFinite(dexPrice) || dexPrice <= 0) return { ok: false, reason: 'missing_dex_price' };
    if (!Number.isFinite(jupiterPrice) || jupiterPrice <= 0) return { ok: false, reason: 'missing_jupiter_price' };

    const divergence = Math.abs((jupiterPrice - dexPrice) / dexPrice) * 100;
    const priceImpactPct = Math.abs(safeNumber(position.lastJupiterPriceImpactPct, 0));
    const jupiterPnl = ((jupiterPrice - position.entryPrice) / position.entryPrice) * 100;
    const elapsedSeconds = getElapsedSeconds(engine);

    if (divergence > sanity.maxDivergencePercent) {
        return { ok: false, reason: `divergence ${divergence.toFixed(2)}%`, divergence, priceImpactPct, jupiterPnl };
    }

    if (priceImpactPct > sanity.maxPriceImpactPct) {
        return { ok: false, reason: `impact ${(priceImpactPct * 100).toFixed(2)}%`, divergence, priceImpactPct, jupiterPnl };
    }

    if (elapsedSeconds <= sanity.extremePnlSeconds && Math.abs(jupiterPnl) > sanity.extremePnlPercent) {
        return { ok: false, reason: `early_extreme_pnl ${jupiterPnl.toFixed(2)}%`, divergence, priceImpactPct, jupiterPnl };
    }

    return { ok: true, reason: `ok divergence ${divergence.toFixed(2)}% impact ${(priceImpactPct * 100).toFixed(2)}%`, divergence, priceImpactPct, jupiterPnl };
}

function applyPriceSanityPatch(engine) {
    if (!engine || engine.__priceSanityPatchApplied) return engine;
    const originalGetActivePositionPrice = engine.getActivePositionPrice?.bind(engine);

    engine.getActivePositionPrice = async function patchedGetActivePositionPrice(timeoutMs = null) {
        const pm = config.priceMonitoring || {};

        if (pm.useJupiterSanityCheck !== true) {
            if (originalGetActivePositionPrice) return originalGetActivePositionPrice(timeoutMs);
            const dexPrice = await this.getDexScreenerPrice(this.currentPosition.pairAddress, false, timeoutMs);
            return { price: dexPrice, source: dexPrice ? 'dexscreener' : 'dex_miss' };
        }

        const dexPrice = await this.getDexScreenerPrice(this.currentPosition.pairAddress, false, timeoutMs);
        let jupiterPrice = null;
        let sanity = { ok: false, reason: 'jupiter_not_checked' };

        try {
            jupiterPrice = await this.getJupiterSellPrice(this.currentPosition, timeoutMs);
            sanity = validateJupiterQuote(this, dexPrice, jupiterPrice);
            this.currentPosition.lastPriceSanity = sanity;

            if (!sanity.ok && jupiterPrice) {
                activityLogger.log('JUPITER_SANITY_REJECTED', {
                    symbol: this.currentPosition.symbol,
                    dexPrice,
                    jupiterPrice,
                    priceImpactPct: this.currentPosition.lastJupiterPriceImpactPct,
                    reason: sanity.reason
                });
            }
        } catch (error) {
            sanity = { ok: false, reason: error.message };
            activityLogger.log('JUPITER_SANITY_ERROR', {
                symbol: this.currentPosition?.symbol,
                error: error.message
            });
        }

        if (dexPrice) {
            return {
                price: dexPrice,
                source: sanity.ok ? 'dexscreener+jupiter_ok' : 'dexscreener+jupiter_reject'
            };
        }

        if (sanity.ok && jupiterPrice) {
            return { price: jupiterPrice, source: 'jupiter_fallback_ok' };
        }

        return { price: null, source: 'price_miss' };
    };

    engine.__priceSanityPatchApplied = true;
    return engine;
}

module.exports = applyPriceSanityPatch;
