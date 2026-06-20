// Distributed token-bucket rate limiter backed by Redis.
//
// The refill-and-consume is done in a single atomic Lua script so that many
// load-balancer workers/instances sharing one Redis enforce ONE global budget
// per client — no read-modify-write race between processes. Idle buckets expire
// automatically via Redis key TTL.
//
// Policy note: on a Redis error we FAIL OPEN (allow the request). For a rate
// limiter, availability of real traffic usually outweighs strict enforcement
// during a Redis blip; flip `failOpen` to false to fail closed instead.

const TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local rate      = tonumber(ARGV[1])   -- tokens per second
local burst     = tonumber(ARGV[2])   -- bucket capacity
local now       = tonumber(ARGV[3])   -- current time, seconds (float)
local requested = tonumber(ARGV[4])   -- tokens to consume

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])

if tokens == nil then
  tokens = burst
  ts = now
end

local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(burst, tokens + elapsed * rate)
  ts = now
end

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
-- Evict idle buckets: TTL = time to fully refill + a small buffer.
local ttl = math.ceil(burst / rate) + 10
redis.call('EXPIRE', key, ttl)

return allowed
`;

export class RedisRateLimiter {
  constructor({
    client,
    rate,
    burst,
    prefix = 'rl:',
    now = () => Date.now() / 1000,
    failOpen = true,
  } = {}) {
    this.client = client;
    this.rate = rate;
    this.burst = burst;
    this.prefix = prefix;
    this.now = now;
    this.failOpen = failOpen;

    // Register the script as a custom command (ioredis caches it via EVALSHA).
    if (typeof client.tokenBucket !== 'function') {
      client.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
    }
  }

  async allow(key) {
    try {
      const allowed = await this.client.tokenBucket(
        this.prefix + key,
        this.rate,
        this.burst,
        this.now(),
        1
      );
      return Number(allowed) === 1;
    } catch (err) {
      if (this.failOpen) {
        return true;
      }
      throw err;
    }
  }

  async stop() {
    try {
      await this.client.quit();
    } catch {
      /* no-op */
    }
  }
}
