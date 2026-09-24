/**
 * TelegramAPI.post() transient-failure retry.
 *
 * Scott, 2026-09-24: "The Telegram is not working properly and has been
 * extremely unstable and buggy over the last several days." The inbound log for
 * 2026-09-23 alone held 91 failures Telegram itself labels retryable (50
 * `fetch failed`, 17 Bad Gateway, 16 timeouts, 8 `Too Many Requests: retry
 * after 5`) against a post() with no retry path at all. Outbound sends take the
 * same code path but are fire-and-forget `.catch(() => {})`, so each blip there
 * silently ate a reply.
 *
 * The two rules that must not regress: transient failures are retried, and
 * 409 Conflict is NOT — TelegramPoller.start() matches /Conflict/i to yield the
 * getUpdates lock, and swallowing it resurrects the 2026-09-22 conflict storm.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api.js';

/** post() is private; these tests exercise it through a public read method. */
function callPost(api: TelegramAPI) {
  return (api as any).post('getUpdates', { offset: 0 });
}

const okBody = { ok: true, result: [] };

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('TelegramAPI.post retry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries a transport failure and returns the eventual success', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, okBody));

    const api = new TelegramAPI('123:abc');
    const promise = callPost(api);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual(okBody);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a Bad Gateway', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(502, { ok: false, description: 'Bad Gateway' }))
      .mockResolvedValueOnce(jsonResponse(200, okBody));

    const api = new TelegramAPI('123:abc');
    const promise = callPost(api);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual(okBody);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits the retry_after Telegram names on a 429, not its own backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {
        ok: false,
        description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      }))
      .mockResolvedValueOnce(jsonResponse(200, okBody));

    const api = new TelegramAPI('123:abc');
    const promise = callPost(api);

    // Default backoff for attempt 1 would be 1s. Telegram asked for 5s, so at
    // 4.9s the retry must not have fired yet.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toEqual(okBody);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 409 Conflict — the poller depends on seeing it at once', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, {
      ok: false,
      description: 'Conflict: terminated by other getUpdates request',
    }));

    const api = new TelegramAPI('123:abc');
    const settled = expect(callPost(api)).rejects.toThrow(/Conflict/i);
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a deterministic 4xx rejection', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, {
      ok: false,
      description: 'Bad Request: BOT_COMMANDS_TOO_MUCH',
    }));

    const api = new TelegramAPI('123:abc');
    const settled = expect(callPost(api)).rejects.toThrow(/BOT_COMMANDS_TOO_MUCH/);
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts and logs, so an exhausted send leaves evidence', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const errorSpy = vi.spyOn(console, 'error');

    const api = new TelegramAPI('123:abc');
    const settled = expect(callPost(api)).rejects.toThrow(/Telegram API request failed/);
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FAILED after 3 attempts'),
    );
  });
});
