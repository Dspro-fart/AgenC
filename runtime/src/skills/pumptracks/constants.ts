/**
 * PumpTracks skill constants.
 *
 * @module
 */

/** Default PumpTracks API base URL */
export const PUMPTRACKS_API_BASE_URL = 'https://pumptracks.fun/api/v1';

/** Default request timeout (60s — minting involves file uploads + IPFS) */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Supported audio file extensions */
export const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

/** Supported image file extensions */
export const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Max audio file size (50MB) */
export const MAX_AUDIO_SIZE = 50 * 1024 * 1024;

/** Max artwork file size (10MB) */
export const MAX_ARTWORK_SIZE = 10 * 1024 * 1024;

/** Minimum SOL required for minting (0.05 SOL initial buy + rent + fees) */
export const MIN_MINT_LAMPORTS = 70_000_000n; // 0.07 SOL

/** PumpTracks platform ID on Raydium LaunchLab (mainnet) */
export const PUMPTRACKS_PLATFORM_ID = 'EjET1WnDdcqb2vBsAJ6Kdq4mKCTSvzrGHUVhKpEX7K4Q';

/**
 * Sensitive file path patterns that must never be read.
 * Checked against the resolved absolute path of any file input.
 */
export const BLOCKED_PATH_PATTERNS: readonly RegExp[] = [
  /\.env/i,
  /\.pem$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.key$/i,
  /secret/i,
  /credential/i,
  /keypair\.json$/i,
  /wallet\.json$/i,
  /\.ssh\//i,
  /\.gnupg\//i,
  /\.aws\//i,
  /\.kube\//i,
];
