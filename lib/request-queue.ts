/**
 * Request Queue System for Viral Traffic Handling
 * 
 * CAPACITY ANALYSIS (per recognition request):
 * ============================================
 * 
 * API CALLS PER REQUEST:
 * - Gemini Face Scans: 12 calls (one per frame)
 * - Gemini Full Analysis: ~8-14 calls (OCR, actors, scenes)
 * - OpenAI Whisper: 1 call (transcription)
 * - OpenAI GPT-4o: 1-2 calls (aggregation + fallback)
 * - TMDB: 5-15 calls (search, cast verification, filmography)
 * 
 * TOTAL: ~27-44 API calls per recognition request
 * 
 * API RATE LIMITS:
 * - Gemini Flash 2.0: 15 RPM (free) / 1000 RPM (paid)
 * - OpenAI GPT-4o: 500 RPM (Tier 1) / 5000 RPM (Tier 4)
 * - OpenAI Whisper: 50 RPM (Tier 1) / 500 RPM (Tier 4)
 * - TMDB: 40 requests per 10 seconds
 * 
 * BOTTLENECK: Gemini API (15 RPM free tier)
 * 
 * CONCURRENT CAPACITY:
 * - Free tier: ~0.5 requests/minute (1 every 2 minutes)
 * - Paid Gemini: ~30-40 requests/minute
 * - Full paid stack: ~50-100 requests/minute
 * 
 * TIME PER REQUEST:
 * - Current: 15-45 seconds (depending on API response times)
 * - With queue: Same, but controlled throughput
 */

interface QueuedRequest {
  id: string;
  timestamp: number;
  priority: number;
  resolve: (value: QueuePosition) => void;
  reject: (error: Error) => void;
}

export interface QueuePosition {
  position: number;
  estimatedWaitSeconds: number;
  canProceed: boolean;
}

export interface QueueStats {
  currentQueueLength: number;
  activeRequests: number;
  maxConcurrent: number;
  avgProcessingTimeMs: number;
  requestsLastMinute: number;
  estimatedWaitForNew: number;
}

class RequestQueue {
  private queue: QueuedRequest[] = [];
  private activeRequests = 0;
  private maxConcurrent: number;
  private processingTimes: number[] = [];
  private requestTimestamps: number[] = [];
  private activeRequestStartTimes: number[] = []; // Track when each active request started
  
  // Configurable limits
  private readonly MAX_QUEUE_SIZE = 50;
  private readonly REQUEST_TIMEOUT_MS = 120000; // 2 minutes max wait in queue
  private readonly MAX_REQUEST_TIME_MS = 180000; // 3 minutes max processing time before auto-release
  
  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
    
    // Clean up old timestamps and stale active requests every 30 seconds
    setInterval(() => {
      const oneMinuteAgo = Date.now() - 60000;
      this.requestTimestamps = this.requestTimestamps.filter(t => t > oneMinuteAgo);
      // Keep only last 100 processing times
      if (this.processingTimes.length > 100) {
        this.processingTimes = this.processingTimes.slice(-100);
      }
      
      // Auto-release stale active requests (safety net for crashed requests)
      this.cleanupStaleRequests();
    }, 30000);
  }
  
  /**
   * Clean up stale requests that have been processing too long
   * This prevents the queue from getting stuck if a request crashes
   */
  private cleanupStaleRequests(): void {
    const now = Date.now();
    const staleThreshold = now - this.MAX_REQUEST_TIME_MS;
    
    // Count how many active requests are stale
    const staleCount = this.activeRequestStartTimes.filter(t => t < staleThreshold).length;
    
    if (staleCount > 0) {
      console.log(`⚠️ Cleaning up ${staleCount} stale active request(s)`);
      
      // Remove stale timestamps
      this.activeRequestStartTimes = this.activeRequestStartTimes.filter(t => t >= staleThreshold);
      
      // Adjust active count
      this.activeRequests = this.activeRequestStartTimes.length;
      
      // Process waiting queue
      this.processQueue();
    }
  }
  
  /**
   * Force reset the queue (for emergency recovery)
   */
  forceReset(): void {
    console.log('🔄 Force resetting request queue');
    this.activeRequests = 0;
    this.activeRequestStartTimes = [];
    this.queue = [];
  }
  
  /**
   * Request a slot in the queue
   * Returns immediately with position, or waits for slot
   */
  async requestSlot(priority: number = 0): Promise<QueuePosition> {
    // Safety check: if no active request start times but activeRequests > 0, reset
    if (this.activeRequests > 0 && this.activeRequestStartTimes.length === 0) {
      console.log('⚠️ Detected orphaned activeRequests count, resetting');
      this.activeRequests = 0;
    }
    
    // Check if queue is full
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error(`Server busy: ${this.queue.length} requests in queue. Please try again in a few minutes.`);
    }
    
    // If we have capacity, proceed immediately
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      this.activeRequestStartTimes.push(Date.now());
      this.requestTimestamps.push(Date.now());
      return {
        position: 0,
        estimatedWaitSeconds: 0,
        canProceed: true,
      };
    }
    
    // Otherwise, add to queue and wait
    const id = Math.random().toString(36).substring(7);
    const timestamp = Date.now();
    
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        id,
        timestamp,
        priority,
        resolve,
        reject,
      };
      
      // Insert based on priority (higher priority = earlier in queue)
      const insertIndex = this.queue.findIndex(r => r.priority < priority);
      if (insertIndex === -1) {
        this.queue.push(request);
      } else {
        this.queue.splice(insertIndex, 0, request);
      }
      
      const position = this.queue.findIndex(r => r.id === id) + 1;
      const estimatedWait = this.estimateWaitTime(position);
      
      console.log(`📋 Request ${id} queued at position ${position}, estimated wait: ${estimatedWait}s`);
      
      // Set timeout for queue
      setTimeout(() => {
        const idx = this.queue.findIndex(r => r.id === id);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new Error('Request timed out in queue. Please try again.'));
        }
      }, this.REQUEST_TIMEOUT_MS);
    });
  }
  
  /**
   * Release a slot when request completes
   */
  releaseSlot(processingTimeMs?: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    
    // Remove oldest active request timestamp
    if (this.activeRequestStartTimes.length > 0) {
      this.activeRequestStartTimes.shift();
    }
    
    if (processingTimeMs) {
      this.processingTimes.push(processingTimeMs);
    }
    
    // Process next in queue
    this.processQueue();
  }
  
  /**
   * Process the next request in queue if capacity available
   */
  private processQueue(): void {
    while (this.activeRequests < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.activeRequests++;
        this.activeRequestStartTimes.push(Date.now());
        this.requestTimestamps.push(Date.now());
        
        const position = 0;
        console.log(`📋 Request ${next.id} proceeding from queue`);
        
        next.resolve({
          position,
          estimatedWaitSeconds: 0,
          canProceed: true,
        });
      }
    }
  }
  
  /**
   * Estimate wait time based on position and average processing time
   */
  private estimateWaitTime(position: number): number {
    const avgTime = this.getAverageProcessingTime();
    // Each position needs to wait for (position / maxConcurrent) cycles
    const cycles = Math.ceil(position / this.maxConcurrent);
    return Math.round((cycles * avgTime) / 1000);
  }
  
  /**
   * Get average processing time in ms
   */
  private getAverageProcessingTime(): number {
    if (this.processingTimes.length === 0) {
      return 30000; // Default 30 seconds
    }
    return this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
  }
  
  /**
   * Get current queue stats
   */
  getStats(): QueueStats {
    const oneMinuteAgo = Date.now() - 60000;
    const requestsLastMinute = this.requestTimestamps.filter(t => t > oneMinuteAgo).length;
    
    return {
      currentQueueLength: this.queue.length,
      activeRequests: this.activeRequests,
      maxConcurrent: this.maxConcurrent,
      avgProcessingTimeMs: this.getAverageProcessingTime(),
      requestsLastMinute,
      estimatedWaitForNew: this.estimateWaitTime(this.queue.length + 1),
    };
  }
  
  /**
   * Check if server can accept new requests
   */
  canAcceptRequest(): boolean {
    return this.queue.length < this.MAX_QUEUE_SIZE;
  }
  
  /**
   * Get queue position for status checking
   */
  getQueuePosition(requestId: string): number {
    const idx = this.queue.findIndex(r => r.id === requestId);
    return idx === -1 ? 0 : idx + 1;
  }
}

// Singleton instance
// Max 3 concurrent recognitions (to stay under rate limits)
export const recognitionQueue = new RequestQueue(3);

/**
 * API Rate Limiters for individual services
 */
class RateLimiter {
  private timestamps: number[] = [];
  private readonly windowMs: number;
  private readonly maxRequests: number;
  
  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }
  
  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => t > now - this.windowMs);
    
    if (this.timestamps.length >= this.maxRequests) {
      const oldestInWindow = Math.min(...this.timestamps);
      const waitTime = oldestInWindow + this.windowMs - now;
      console.log(`⏳ Rate limit hit, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime + 100));
    }
    
    this.timestamps.push(Date.now());
  }
  
  getUsage(): { current: number; max: number; windowMs: number } {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => t > now - this.windowMs);
    return {
      current: this.timestamps.length,
      max: this.maxRequests,
      windowMs: this.windowMs,
    };
  }
}

// Rate limiters for each API
// Conservative limits to prevent 429 errors
export const rateLimiters = {
  gemini: new RateLimiter(12, 60000),    // 12 per minute (conservative for free tier)
  openai: new RateLimiter(40, 60000),    // 40 per minute
  whisper: new RateLimiter(10, 60000),   // 10 per minute (conservative)
  tmdb: new RateLimiter(35, 10000),      // 35 per 10 seconds
};

/**
 * Wrap an API call with rate limiting
 */
export async function withRateLimit<T>(
  limiter: RateLimiter,
  fn: () => Promise<T>
): Promise<T> {
  await limiter.acquire();
  return fn();
}

/**
 * Get overall system health and capacity
 */
export function getSystemHealth(): {
  healthy: boolean;
  queueStats: QueueStats;
  rateLimits: Record<string, { current: number; max: number; percentage: number }>;
  recommendations: string[];
} {
  const queueStats = recognitionQueue.getStats();
  const recommendations: string[] = [];
  
  const rateLimits: Record<string, { current: number; max: number; percentage: number }> = {};
  for (const [name, limiter] of Object.entries(rateLimiters)) {
    const usage = limiter.getUsage();
    rateLimits[name] = {
      current: usage.current,
      max: usage.max,
      percentage: Math.round((usage.current / usage.max) * 100),
    };
    
    if (usage.current / usage.max > 0.8) {
      recommendations.push(`${name} API at ${Math.round((usage.current / usage.max) * 100)}% capacity`);
    }
  }
  
  if (queueStats.currentQueueLength > 10) {
    recommendations.push('High queue length - consider scaling up');
  }
  
  if (queueStats.avgProcessingTimeMs > 45000) {
    recommendations.push('Slow processing times - check API latency');
  }
  
  const healthy = queueStats.currentQueueLength < 20 && 
                  Object.values(rateLimits).every(r => r.percentage < 90);
  
  return {
    healthy,
    queueStats,
    rateLimits,
    recommendations,
  };
}
