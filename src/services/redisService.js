/**
 * Redis Service
 * 
 * Manages the Redis connection used by both the Order Book (sorted sets)
 * and BullMQ (queues). Provides a singleton IORedis instance and a
 * health-check helper so callers can gracefully fall back to MongoDB
 * when Redis is unavailable.
 */

const Redis = require('ioredis');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  /**
   * Initialise (or return existing) Redis connection.
   * Call once at server startup; every other service imports the singleton.
   */
  init() {
    if (this.client) return this.client;

    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,   // Required by BullMQ
      enableReadyCheck: true,
      retryStrategy: (times) => {
        if (times > 10) {
          console.error('❌ [Redis] Max reconnect attempts reached');
          return null;                // Stop retrying
        }
        const delay = Math.min(times * 500, 5000);
        console.log(`🔄 [Redis] Reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
      },
    });

    this.client.on('connect', () => {
      console.log('✅ [Redis] Connected');
      this.isConnected = true;
    });

    this.client.on('ready', () => {
      console.log('✅ [Redis] Ready');
      this.isConnected = true;
    });

    this.client.on('error', (err) => {
      console.error('❌ [Redis] Error:', err.message);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      console.log('⚠️  [Redis] Connection closed');
      this.isConnected = false;
    });

    return this.client;
  }

  /** Quick health check */
  isAvailable() {
    return this.isConnected && this.client && this.client.status === 'ready';
  }

  /** Return the raw IORedis instance (for BullMQ, etc.) */
  getClient() {
    return this.client;
  }

  /** Graceful shutdown */
  async shutdown() {
    if (this.client) {
      console.log('🛑 [Redis] Shutting down...');
      await this.client.quit();
      this.isConnected = false;
    }
  }
}

module.exports = new RedisService();
