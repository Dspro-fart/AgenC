/**
 * PumpTracks music token skill implementation.
 *
 * Provides track browsing, searching, artist lookup, and full
 * music token minting via the Raydium LaunchLab SDK.
 *
 * Security:
 * - The agent builds its own Raydium transaction locally — NO external
 *   server ever provides transaction bytes for signing
 * - PumpTracks is used ONLY for file uploads (audio/artwork/IPFS) and
 *   track registration (saving metadata after on-chain confirmation)
 * - File path traversal protection with blocked-path patterns
 * - SOL balance guard before minting
 *
 * @module
 */

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import {
  Raydium,
  TxVersion,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadConfigId,
  LaunchpadConfig,
} from '@raydium-io/raydium-sdk-v2';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import type { Skill, SkillMetadata, SkillAction, SkillContext, SemanticVersion } from '../types.js';
import { SkillState } from '../types.js';
import { SkillNotReadyError } from '../errors.js';
import { PumpTracksClient } from './pumptracks-client.js';
import {
  PUMPTRACKS_API_BASE_URL,
  PUMPTRACKS_PLATFORM_ID,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  MAX_AUDIO_SIZE,
  MAX_ARTWORK_SIZE,
  MIN_MINT_LAMPORTS,
  BLOCKED_PATH_PATTERNS,
} from './constants.js';
import type {
  PumpTracksSkillConfig,
  ListTracksParams,
  SearchTracksParams,
  MintTrackParams,
  Track,
  Artist,
  MintResult,
} from './types.js';
import type { Logger } from '../../utils/logger.js';
import type { Wallet } from '../../types/wallet.js';
import { Capability } from '../../agent/capabilities.js';
import * as fs from 'fs';
import * as path from 'path';

const VERSION: SemanticVersion = '0.1.0';

/**
 * PumpTracks skill for launching music tokens on Solana.
 *
 * Actions:
 * - `getTracks`    — List tracks with optional filters (genre, artist, sort)
 * - `getTrack`     — Get a single track by mint address
 * - `searchTracks` — Search tracks by title, artist, or symbol
 * - `getArtist`    — Get artist profile and their tracks
 * - `mintTrack`    — Full end-to-end mint: upload files, build tx locally, broadcast to Solana
 *
 * @example
 * ```typescript
 * const pumptracks = new PumpTracksSkill({
 *   apiKey: 'pt_live_xxxxxxxxxxxxx',
 * });
 * const registry = new SkillRegistry();
 * registry.register(pumptracks);
 * await registry.initializeAll({ connection, wallet, logger });
 *
 * // Browse tracks
 * const tracks = await pumptracks.getTracks({ genre: 'Electronic', limit: 10 });
 *
 * // Mint a new music token
 * const result = await pumptracks.mintTrack({
 *   audio: './song.mp3',
 *   artwork: './cover.jpg',
 *   title: 'My Song',
 *   artist: 'Artist Name',
 *   genre: 'Electronic',
 * });
 * console.log(`Track live at: ${result.playUrl}`);
 * ```
 */
export class PumpTracksSkill implements Skill {
  readonly metadata: SkillMetadata = {
    name: 'pumptracks',
    description: 'PumpTracks music token launchpad — mint, browse, and search music tokens on Solana',
    version: VERSION,
    requiredCapabilities: Capability.COMPUTE | Capability.NETWORK,
    tags: ['music', 'nft', 'token', 'mint', 'solana', 'pumptracks'],
  };

  private _state: SkillState = SkillState.Created;
  private connection: Connection | null = null;
  private wallet: Wallet | null = null;
  private logger: Logger | null = null;
  private client: PumpTracksClient | null = null;

  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  private readonly actions: ReadonlyArray<SkillAction>;

  constructor(config: PumpTracksSkillConfig) {
    this.apiKey = config.apiKey;
    this.apiBaseUrl = config.apiBaseUrl ?? PUMPTRACKS_API_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.actions = [
      {
        name: 'getTracks',
        description: 'List music tracks on PumpTracks with optional filters (genre, artist, sort)',
        execute: (params: unknown) => this.getTracks(params as ListTracksParams),
      },
      {
        name: 'getTrack',
        description: 'Get a single track by its Solana mint address',
        execute: (params: unknown) => {
          const p = params as { mint: string };
          return this.getTrack(p.mint);
        },
      },
      {
        name: 'searchTracks',
        description: 'Search for tracks by title, artist name, or token symbol',
        execute: (params: unknown) => this.searchTracks(params as SearchTracksParams),
      },
      {
        name: 'getArtist',
        description: 'Get an artist profile and their tracks by wallet address',
        execute: (params: unknown) => {
          const p = params as { wallet: string };
          return this.getArtist(p.wallet);
        },
      },
      {
        name: 'mintTrack',
        description: 'Mint a new music token on PumpTracks. The agent generates its own mint keypair, uploads files to PumpTracks for hosting, then builds and signs the Raydium LaunchLab transaction LOCALLY using the SDK. No external server ever provides transaction bytes. Requires ~0.07 SOL.',
        execute: (params: unknown) => this.mintTrack(params as MintTrackParams),
      },
    ];
  }

  get state(): SkillState {
    return this._state;
  }

  async initialize(context: SkillContext): Promise<void> {
    this._state = SkillState.Initializing;
    try {
      this.connection = context.connection;
      this.wallet = context.wallet;
      this.logger = context.logger;
      this.client = new PumpTracksClient({
        apiBaseUrl: this.apiBaseUrl,
        apiKey: this.apiKey,
        timeoutMs: this.timeoutMs,
        logger: context.logger,
      });
      this._state = SkillState.Ready;
    } catch (err) {
      this._state = SkillState.Error;
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this._state = SkillState.ShuttingDown;
    this.client = null;
    this.connection = null;
    this.wallet = null;
    this.logger = null;
    this._state = SkillState.Stopped;
  }

  getActions(): ReadonlyArray<SkillAction> {
    return this.actions;
  }

  getAction(name: string): SkillAction | undefined {
    return this.actions.find((a) => a.name === name);
  }

  // ============================================================================
  // Typed action methods
  // ============================================================================

  async getTracks(params?: ListTracksParams): Promise<Track[]> {
    this.ensureReady();
    return this.client!.listTracks(params);
  }

  async getTrack(mint: string): Promise<Track> {
    this.ensureReady();
    return this.client!.getTrack(mint);
  }

  async searchTracks(params: SearchTracksParams): Promise<Track[]> {
    this.ensureReady();
    return this.client!.searchTracks(params);
  }

  async getArtist(wallet: string): Promise<Artist> {
    this.ensureReady();
    return this.client!.getArtist(wallet);
  }

  /**
   * Full end-to-end mint flow — the agent builds its own transaction:
   *
   * 1. Validate file paths (no traversal, no sensitive files)
   * 2. Check SOL balance (must have >= 0.07 SOL)
   * 3. Generate mint keypair LOCALLY (agent controls the mint)
   * 4. Upload files to PumpTracks for hosting (files only, no transactions)
   * 5. Build Raydium LaunchLab transaction LOCALLY using the SDK
   * 6. Sign with the agent's wallet + mint keypair
   * 7. Broadcast directly to Solana
   * 8. Register track on PumpTracks (mint address + tx IDs only)
   *
   * PumpTracks NEVER sees, builds, or touches any transaction.
   * The agent is in full control of what it signs because it built
   * the transaction itself using the Raydium SDK.
   *
   * @returns Mint address, tx IDs, and play URL
   */
  async mintTrack(params: MintTrackParams): Promise<MintResult> {
    this.ensureReady();

    const walletAddress = this.wallet!.publicKey.toBase58();
    this.logger!.info(`PumpTracks: minting "${params.title}" by ${params.artist}...`);

    // ── Security: Validate & read files ──
    const { audioBlob, audioFilename, artBlob, artFilename } = this.loadAndValidateFiles(params);

    // ── Security: Check SOL balance ──
    await this.ensureSufficientBalance();

    // ── Step 1: Generate mint keypair LOCALLY ──
    // The agent controls this keypair — PumpTracks never sees the secret key.
    const mintKeypair = Keypair.generate();
    const mintAddress = mintKeypair.publicKey.toBase58();
    this.logger!.info(`PumpTracks: generated mint keypair locally: ${mintAddress}`);

    // ── Step 2: Upload files to PumpTracks (files only, NO transactions) ──
    // PumpTracks handles Firebase Storage + IPFS hosting.
    // It returns URIs — never transaction bytes.
    this.logger!.info('PumpTracks: uploading files...');
    const formData = new FormData();
    formData.append('audio', audioBlob, audioFilename);
    formData.append('artwork', artBlob, artFilename);
    formData.append('title', params.title);
    formData.append('artist', params.artist);
    formData.append('genre', params.genre);
    formData.append('wallet', walletAddress);
    formData.append('mint', mintAddress);
    if (params.twitter) formData.append('twitter', params.twitter);
    if (params.tiktok) formData.append('tiktok', params.tiktok);
    if (params.instagram) formData.append('instagram', params.instagram);

    const uploadResult = await this.client!.uploadFiles(formData);
    this.logger!.info(`PumpTracks: files uploaded, metadataUri = ${uploadResult.metadataUri}`);

    // ── Step 3: Build Raydium LaunchLab transaction LOCALLY ──
    // The agent uses the Raydium SDK directly. No external server
    // provides transaction bytes — we build them ourselves.
    this.logger!.info('PumpTracks: building Raydium transaction locally...');

    const raydium = await Raydium.load({
      connection: this.connection!,
      owner: this.wallet!.publicKey,
      signAllTransactions: this.wallet!.signAllTransactions.bind(this.wallet),
      cluster: 'mainnet',
      disableFeatureCheck: true,
      blockhashCommitment: 'finalized',
    });

    // Read LaunchLab config from chain
    const programId = LAUNCHPAD_PROGRAM;
    const configId = getPdaLaunchpadConfigId(programId, NATIVE_MINT, 0, 0).publicKey;
    const configData = await this.connection!.getAccountInfo(configId);
    if (!configData) {
      throw new Error('Raydium LaunchLab config not found on-chain. Check network/RPC.');
    }
    const configInfo = LaunchpadConfig.decode(configData.data);

    const initialBuyLamports = params.initialBuyLamports ?? 50_000_000; // 0.05 SOL

    const { execute } = await raydium.launchpad.createLaunchpad({
      programId,
      mintA: mintKeypair.publicKey,
      decimals: 6,
      name: params.artist,
      symbol: uploadResult.symbol,
      migrateType: 'cpmm',
      uri: uploadResult.metadataUri,
      configId,
      configInfo,
      mintBDecimals: 9,
      platformId: new PublicKey(PUMPTRACKS_PLATFORM_ID),
      txVersion: TxVersion.V0,
      slippage: new BN(100),
      buyAmount: new BN(initialBuyLamports),
      createOnly: false,
      extraSigners: [mintKeypair],
      computeBudgetConfig: {
        microLamports: 100_000,
      },
    });

    // ── Step 4: Sign with agent wallet + broadcast to Solana ──
    this.logger!.info('PumpTracks: signing and broadcasting to Solana...');
    const result = await execute({ sequentially: true, sendAndConfirm: true });
    const txIds = result.txIds || [];

    if (txIds.length === 0) {
      throw new Error('Transaction broadcast returned no tx IDs');
    }

    this.logger!.info(`PumpTracks: confirmed on-chain, txIds: ${txIds.join(', ')}`);

    // ── Step 5: Register track on PumpTracks ──
    // Only sends mint address + tx IDs + metadata.
    // PumpTracks verifies the mint exists on-chain before saving.
    this.logger!.info('PumpTracks: registering track on PumpTracks...');
    const registerResult = await this.client!.registerTrack(
      mintAddress,
      txIds,
      {
        title: params.title,
        artist: params.artist,
        genre: params.genre,
        symbol: uploadResult.symbol,
        metadataUri: uploadResult.metadataUri,
        artUri: uploadResult.artUri,
        trackUri: uploadResult.trackUri,
        wallet: walletAddress,
        ...(params.twitter && { twitter: params.twitter }),
        ...(params.tiktok && { tiktok: params.tiktok }),
        ...(params.instagram && { instagram: params.instagram }),
      },
    );

    this.logger!.info(`PumpTracks: track live at ${registerResult.playUrl}`);
    return registerResult;
  }

  // ============================================================================
  // Security: File path validation
  // ============================================================================

  private loadAndValidateFiles(params: MintTrackParams): {
    audioBlob: Blob;
    audioFilename: string;
    artBlob: Blob;
    artFilename: string;
  } {
    let audioBlob: Blob;
    let audioFilename: string;
    let artBlob: Blob;
    let artFilename: string;

    if (typeof params.audio === 'string') {
      const { buffer, filename } = this.validateAndReadFile(
        params.audio,
        ALLOWED_AUDIO_EXTENSIONS,
        MAX_AUDIO_SIZE,
        'audio',
      );
      audioBlob = new Blob([buffer]);
      audioFilename = filename;
    } else {
      if (params.audio.byteLength > MAX_AUDIO_SIZE) {
        throw new Error(`Audio buffer exceeds maximum size of ${MAX_AUDIO_SIZE} bytes`);
      }
      audioBlob = new Blob([params.audio]);
      audioFilename = params.audioFilename || 'track.mp3';
    }

    if (typeof params.artwork === 'string') {
      const { buffer, filename } = this.validateAndReadFile(
        params.artwork,
        ALLOWED_IMAGE_EXTENSIONS,
        MAX_ARTWORK_SIZE,
        'artwork',
      );
      artBlob = new Blob([buffer]);
      artFilename = filename;
    } else {
      if (params.artwork.byteLength > MAX_ARTWORK_SIZE) {
        throw new Error(`Artwork buffer exceeds maximum size of ${MAX_ARTWORK_SIZE} bytes`);
      }
      artBlob = new Blob([params.artwork]);
      artFilename = params.artworkFilename || 'cover.jpg';
    }

    return { audioBlob, audioFilename, artBlob, artFilename };
  }

  private validateAndReadFile(
    filePath: string,
    allowedExtensions: ReadonlySet<string>,
    maxSize: number,
    label: string,
  ): { buffer: Buffer; filename: string } {
    const resolved = path.resolve(filePath);

    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        throw new Error(
          `Refused to read ${label} file: path "${filePath}" matches blocked pattern. ` +
          `This may be a sensitive file (keys, credentials, env).`,
        );
      }
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(
        `Invalid ${label} file extension "${ext}". Allowed: ${[...allowedExtensions].join(', ')}`,
      );
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`${label} file not found: ${filePath}`);
    }

    const stats = fs.statSync(resolved);
    if (stats.size > maxSize) {
      throw new Error(
        `${label} file too large: ${stats.size} bytes (max ${maxSize} bytes)`,
      );
    }

    const buffer = fs.readFileSync(resolved);
    const filename = path.basename(resolved);

    return { buffer, filename };
  }

  // ============================================================================
  // Security: Balance guard
  // ============================================================================

  private async ensureSufficientBalance(): Promise<void> {
    const balance = await this.connection!.getBalance(this.wallet!.publicKey);
    const balanceBigInt = BigInt(balance);

    if (balanceBigInt < MIN_MINT_LAMPORTS) {
      const balanceSol = balance / LAMPORTS_PER_SOL;
      const requiredSol = Number(MIN_MINT_LAMPORTS) / LAMPORTS_PER_SOL;
      throw new Error(
        `Insufficient SOL balance: ${balanceSol.toFixed(4)} SOL. ` +
        `Minting requires at least ${requiredSol} SOL (0.05 initial buy + rent/fees).`,
      );
    }

    this.logger!.debug(
      `PumpTracks: balance check passed (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
    );
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private ensureReady(): void {
    if (this._state !== SkillState.Ready) {
      throw new SkillNotReadyError('pumptracks');
    }
  }
}
