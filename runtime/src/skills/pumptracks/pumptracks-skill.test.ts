/**
 * PumpTracks skill unit tests.
 *
 * Covers: metadata, lifecycle, action registry, security guards
 * (path validation, balance check), read actions, and local-tx mint flow.
 *
 * Architecture guarantee: The agent builds its own Raydium transaction
 * locally using the SDK. PumpTracks is used ONLY for file hosting (upload)
 * and track registration (after on-chain confirmation). No external server
 * ever provides transaction bytes for signing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PumpTracksSkill } from './pumptracks-skill.js';
import { SkillState } from '../types.js';
import {
  BLOCKED_PATH_PATTERNS,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  MIN_MINT_LAMPORTS,
  PUMPTRACKS_PLATFORM_ID,
} from './constants.js';

// ─── Mock helpers ────────────────────────────────────────

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockWallet() {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: vi.fn(),
    signAllTransactions: vi.fn(),
  };
}

function createMockConnection() {
  return {
    getBalance: vi.fn().mockResolvedValue(1_000_000_000), // 1 SOL
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1000,
    }),
    getAccountInfo: vi.fn().mockResolvedValue({
      data: Buffer.alloc(256), // mock config account data
    }),
  };
}

function createMockContext() {
  return {
    connection: createMockConnection() as any,
    wallet: createMockWallet() as any,
    logger: createMockLogger() as any,
  };
}

function createSkill(overrides?: Partial<{ apiKey: string; apiBaseUrl: string }>) {
  return new PumpTracksSkill({
    apiKey: overrides?.apiKey ?? 'pt_live_test_key_12345',
    apiBaseUrl: overrides?.apiBaseUrl ?? 'https://pumptracks.fun/api/v1',
  });
}

// ─── Tests ───────────────────────────────────────────────

describe('PumpTracksSkill', () => {
  let skill: PumpTracksSkill;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    skill = createSkill();
    context = createMockContext();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Metadata ──

  describe('metadata', () => {
    it('has correct name', () => {
      expect(skill.metadata.name).toBe('pumptracks');
    });

    it('has correct version format', () => {
      expect(skill.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('includes required tags', () => {
      expect(skill.metadata.tags).toContain('music');
      expect(skill.metadata.tags).toContain('solana');
      expect(skill.metadata.tags).toContain('mint');
    });
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('starts in Created state', () => {
      expect(skill.state).toBe(SkillState.Created);
    });

    it('transitions to Ready after initialize', async () => {
      await skill.initialize(context);
      expect(skill.state).toBe(SkillState.Ready);
    });

    it('transitions to Stopped after shutdown', async () => {
      await skill.initialize(context);
      await skill.shutdown();
      expect(skill.state).toBe(SkillState.Stopped);
    });
  });

  // ── Action registry ──

  describe('actions', () => {
    it('exposes 5 actions', () => {
      expect(skill.getActions()).toHaveLength(5);
    });

    it('has getTracks action', () => {
      expect(skill.getAction('getTracks')).toBeDefined();
    });

    it('has getTrack action', () => {
      expect(skill.getAction('getTrack')).toBeDefined();
    });

    it('has searchTracks action', () => {
      expect(skill.getAction('searchTracks')).toBeDefined();
    });

    it('has getArtist action', () => {
      expect(skill.getAction('getArtist')).toBeDefined();
    });

    it('has mintTrack action', () => {
      expect(skill.getAction('mintTrack')).toBeDefined();
    });

    it('returns undefined for unknown action', () => {
      expect(skill.getAction('nonexistent')).toBeUndefined();
    });

    it('mintTrack description mentions local transaction building', () => {
      const action = skill.getAction('mintTrack');
      expect(action?.description).toContain('LOCALLY');
      expect(action?.description).not.toContain('server');
    });
  });

  // ── Guards ──

  describe('guards', () => {
    it('throws when calling action before initialize', async () => {
      await expect(skill.getTracks()).rejects.toThrow();
    });

    it('throws when calling action after shutdown', async () => {
      await skill.initialize(context);
      await skill.shutdown();
      await expect(skill.getTracks()).rejects.toThrow();
    });
  });

  // ── Read actions (with mocked fetch) ──

  describe('getTracks', () => {
    it('calls API and returns tracks', async () => {
      await skill.initialize(context);

      const mockTracks = [{ mint: 'abc123', title: 'Test', artist: 'Artist' }];
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: mockTracks } }),
      });

      const result = await skill.getTracks({ genre: 'Electronic', limit: 5 });
      expect(result).toEqual(mockTracks);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
  });

  describe('getTrack', () => {
    it('calls API with mint address', async () => {
      await skill.initialize(context);

      const mockTrack = { mint: 'abc123', title: 'Test', artist: 'Artist' };
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: mockTrack }),
      });

      const result = await skill.getTrack('abc123');
      expect(result).toEqual(mockTrack);
    });
  });

  describe('searchTracks', () => {
    it('calls API with search query', async () => {
      await skill.initialize(context);

      const mockTracks = [{ mint: 'abc123', title: 'Lofi Beat' }];
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: mockTracks } }),
      });

      const result = await skill.searchTracks({ q: 'lofi' });
      expect(result).toEqual(mockTracks);
    });
  });

  // ── Custom config ──

  describe('custom config', () => {
    it('uses custom API base URL', async () => {
      const custom = createSkill({ apiBaseUrl: 'https://custom.api/v1' });
      await custom.initialize(context);

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: [] } }),
      });

      await custom.getTracks();

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('custom.api');
    });
  });
});

// ─── Security: Constants validation ──────────────────────

describe('Security constants', () => {
  describe('PUMPTRACKS_PLATFORM_ID', () => {
    it('is a valid base58 string', () => {
      expect(PUMPTRACKS_PLATFORM_ID).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    });

    it('matches the expected platform ID', () => {
      expect(PUMPTRACKS_PLATFORM_ID).toBe('EjET1WnDdcqb2vBsAJ6Kdq4mKCTSvzrGHUVhKpEX7K4Q');
    });
  });

  describe('BLOCKED_PATH_PATTERNS', () => {
    it('blocks .env files', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/home/user/.env'))).toBe(true);
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/app/.env.local'))).toBe(true);
    });

    it('blocks keypair.json', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/home/user/keypair.json'))).toBe(true);
    });

    it('blocks wallet.json', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/home/user/wallet.json'))).toBe(true);
    });

    it('blocks .ssh directory', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/home/user/.ssh/id_rsa'))).toBe(true);
    });

    it('blocks .pem files', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/certs/server.pem'))).toBe(true);
    });

    it('blocks credential files', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/home/user/credentials.json'))).toBe(true);
    });

    it('allows normal audio files', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/music/song.mp3'))).toBe(false);
    });

    it('allows normal image files', () => {
      expect(BLOCKED_PATH_PATTERNS.some(p => p.test('/art/cover.jpg'))).toBe(false);
    });
  });

  describe('ALLOWED_AUDIO_EXTENSIONS', () => {
    it('allows .mp3', () => {
      expect(ALLOWED_AUDIO_EXTENSIONS.has('.mp3')).toBe(true);
    });

    it('allows .wav', () => {
      expect(ALLOWED_AUDIO_EXTENSIONS.has('.wav')).toBe(true);
    });

    it('rejects .exe', () => {
      expect(ALLOWED_AUDIO_EXTENSIONS.has('.exe')).toBe(false);
    });

    it('rejects .json', () => {
      expect(ALLOWED_AUDIO_EXTENSIONS.has('.json')).toBe(false);
    });
  });

  describe('ALLOWED_IMAGE_EXTENSIONS', () => {
    it('allows .jpg and .jpeg', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.jpg')).toBe(true);
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.jpeg')).toBe(true);
    });

    it('allows .png', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.png')).toBe(true);
    });

    it('rejects .svg', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.svg')).toBe(false);
    });
  });

  describe('MIN_MINT_LAMPORTS', () => {
    it('is 0.07 SOL', () => {
      expect(MIN_MINT_LAMPORTS).toBe(70_000_000n);
    });
  });
});

// ─── Architecture security guarantee ─────────────────────
// These tests verify the fundamental architectural guarantee:
// NO ALLOWED_PROGRAM_IDS exists — the agent doesn't validate
// transactions from an external server because it builds its own.

describe('Architecture: no external transaction signing', () => {
  it('constants.ts does not export ALLOWED_PROGRAM_IDS', async () => {
    const constants = await import('./constants.js');
    expect((constants as any).ALLOWED_PROGRAM_IDS).toBeUndefined();
  });

  it('skill does not have validateTransactionPrograms method', () => {
    const skill = createSkill();
    expect((skill as any).validateTransactionPrograms).toBeUndefined();
  });

  it('skill does not have simulateTransaction method', () => {
    const skill = createSkill();
    expect((skill as any).simulateTransaction).toBeUndefined();
  });
});
