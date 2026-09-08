/**
 * OrderFlowConfig.js
 * Centralized Research Parameters & Quant Threshold Configuration.
 */

export class OrderFlowConfig {
  constructor(customConfig = {}) {
    // Imbalance Settings
    this.imbalanceRatio = 3.0;               // 3.0 = 300% buy/sell ratio
    this.stackedImbalanceMinLevels = 3;       // 3+ consecutive price levels
    this.imbalanceMinVolume = 5;              // Min volume to validate imbalance

    // Value Area Settings
    this.valueAreaPercent = 0.70;             // 70% of candle/session volume

    // Absorption Signal Settings
    this.absorptionVolStdDev = 2.0;           // Volume exceeds 2.0 std devs of mean
    this.absorptionDeltaSkew = 0.60;          // 60%+ net directional delta
    this.absorptionMaxDisplacementPips = 1.5; // Max 1.5 pips price movement

    // Exhaustion Signal Settings
    this.exhaustionRatio = 0.15;              // Extreme volume < 15% of POC volume
    this.exhaustionMinPipsFromPOC = 2.0;

    // Liquidity Sweep Settings
    this.sweepPipThreshold = 2.0;             // Min pips penetration of key high/low
    this.sweepMaxRejectionPips = 15.0;

    // Apply custom overrides
    Object.assign(this, customConfig);
  }

  update(newParams) {
    Object.assign(this, newParams);
    return this;
  }
}

export const defaultConfig = new OrderFlowConfig();
