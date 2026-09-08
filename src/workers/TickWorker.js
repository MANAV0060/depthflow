/**
 * TickWorker.js
 * Background Web Worker Engine for High-Throughput Tick Ingestion & Order Flow Math.
 */

import { AdaptiveClassifier } from '../analytics/AdaptiveClassifier.js';
import { FootprintAggregator } from '../analytics/FootprintAggregator.js';
import { DeltaEngine } from '../analytics/DeltaEngine.js';
import { PatternDetector } from '../analytics/PatternDetector.js';

const classifier = new AdaptiveClassifier();
const aggregator = new FootprintAggregator({ timeframeMs: 60000 });
const deltaEngine = new DeltaEngine();
const patternDetector = new PatternDetector();

const ringBuffer = [];
const MAX_BUFFER_CAPACITY = 50000;

self.onmessage = function (e) {
  const { type, payload } = e.data;

  if (type === 'PROCESS_EVENT') {
    const normEvent = payload;

    // 1. Adaptive Aggressor Classification
    const aggressorResult = classifier.classify(normEvent);

    // 2. Add to Ring Buffer
    ringBuffer.push({ event: normEvent, aggressorResult });
    if (ringBuffer.length > MAX_BUFFER_CAPACITY) {
      ringBuffer.shift();
    }

    // 3. Aggregate into Footprint Candle
    const activeCandle = aggregator.processEvent(normEvent, aggressorResult);

    // 4. Pattern Detection
    const signals = patternDetector.detectPatterns(activeCandle);

    // 5. Send updated snapshot to Main Thread
    self.postMessage({
      type: 'TICK_PROCESSED',
      payload: {
        event: normEvent,
        aggressorResult,
        candle: {
          startTime: activeCandle.startTime,
          open: activeCandle.open,
          high: activeCandle.high,
          low: activeCandle.low,
          close: activeCandle.close,
          totalVolume: activeCandle.totalVolume,
          totalDelta: activeCandle.totalDelta,
          pocPrice: activeCandle.pocPrice,
          fidelityMode: activeCandle.fidelityMode,
          cells: activeCandle.getSortedCells()
        },
        signals
      }
    });
  } else if (type === 'RESET') {
    ringBuffer.length = 0;
    self.postMessage({ type: 'RESET_COMPLETE' });
  }
};
