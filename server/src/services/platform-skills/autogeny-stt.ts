/**
 * autogeny-stt — Platform skill that exposes speech-to-text transcription to agents.
 *
 * Wraps `scripts/transcribe.py` (Google Cloud / Whisper) and exposes an
 * `autogeny_transcribe` tool. Audio data is passed as a base64-encoded string.
 *
 * Security:
 * - MIME type is validated against an allowlist before any file I/O
 * - Base64 format is validated before decoding (Buffer.from silently ignores bad chars)
 * - Audio size is capped at MAX_AUDIO_BYTES
 * - Temp file is written with a random UUID name and cleaned up in a finally block
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { PlatformSkill, SkillContext, ToolDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SKILL_ID = "autogeny-stt";

const TRANSCRIBE_SCRIPT =
  process.env.TRANSCRIBE_SCRIPT ?? "/root/.openclaw/workspace/scripts/transcribe.py";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

/** Allowed MIME type prefixes. Prevents arbitrary file injection. */
const ALLOWED_MIME_PREFIXES = ["audio/", "video/"];

/** ~50 MB max audio payload (base64 expands ~33%, so raw audio ≤ ~37 MB) */
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/** Strict base64 pattern: only A-Za-z0-9+/ with optional = padding */
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscribeParams {
  audioBase64: string;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Transcription logic
// ---------------------------------------------------------------------------

/**
 * Validate that the MIME type is an audio or video type.
 */
export function validateMimeType(mimeType: string): void {
  const lower = mimeType.toLowerCase();
  const allowed = ALLOWED_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!allowed) {
    throw new Error(
      `autogeny_transcribe: unsupported mimeType '${mimeType}'. Must be audio/* or video/*.`,
    );
  }
}

/**
 * Derive a safe file extension from the MIME type.
 */
export function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
  };
  const key = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return map[key] ?? "bin";
}

/**
 * Execute transcription against a file path.
 * Exported so tests can substitute the exec function.
 */
export async function runTranscription(
  audioFilePath: string,
  execFn: typeof execFileAsync = execFileAsync,
): Promise<string> {
  const { stdout, stderr } = await execFn(PYTHON_BIN, [TRANSCRIBE_SCRIPT, audioFilePath]);
  if (stderr && stderr.trim()) {
    // Log but don't fail — some backends emit non-fatal warnings to stderr
    process.stderr.write(`[autogeny-stt] transcription stderr: ${stderr}\n`);
  }
  return stdout.trim();
}

/**
 * Full transcription pipeline: validate → decode base64 → write temp file → transcribe → cleanup.
 */
export async function transcribeBase64(
  params: TranscribeParams,
  execFn: typeof execFileAsync = execFileAsync,
): Promise<string> {
  validateMimeType(params.mimeType);

  // Validate base64 format before decoding.
  // Buffer.from() silently ignores invalid base64 characters, so we validate explicitly.
  if (!BASE64_REGEX.test(params.audioBase64)) {
    throw new Error("autogeny_transcribe: 'audioBase64' is not valid base64");
  }

  const audioBuffer = Buffer.from(params.audioBase64, "base64");

  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error(
      `autogeny_transcribe: audio data exceeds maximum size of ${MAX_AUDIO_BYTES / (1024 * 1024)}MB`,
    );
  }

  const ext = mimeToExtension(params.mimeType);
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `autogeny-stt-${randomUUID()}.${ext}`);

  await fs.writeFile(tmpFile, audioBuffer);

  try {
    return await runTranscription(tmpFile, execFn);
  } finally {
    await fs.unlink(tmpFile).catch(() => {
      // Best-effort cleanup — don't mask the real error
    });
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const toolDefinitions: ToolDefinition[] = [
  {
    name: "autogeny_transcribe",
    displayName: "Autogeny Speech-to-Text",
    description:
      "Transcribe an audio or video file to text using the Autogeny platform's " +
      "speech-to-text service (Google Cloud Speech / Whisper). " +
      "Pass audio as a base64-encoded string along with its MIME type. " +
      "Returns the transcript as plain text.",
    parametersSchema: {
      type: "object",
      properties: {
        audioBase64: {
          type: "string",
          description: "Base64-encoded audio or video file content (max ~50 MB).",
        },
        mimeType: {
          type: "string",
          description:
            "MIME type of the audio/video data (e.g. 'audio/wav', 'audio/mpeg', 'audio/webm').",
        },
      },
      required: ["audioBase64", "mimeType"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const toolHandlers: PlatformSkill["toolHandlers"] = {
  autogeny_transcribe: async (params: unknown, _ctx: SkillContext) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("autogeny_transcribe: params must be an object");
    }
    const { audioBase64, mimeType } = params as TranscribeParams;
    if (!audioBase64 || typeof audioBase64 !== "string") {
      throw new Error("autogeny_transcribe: 'audioBase64' must be a non-empty string");
    }
    if (!mimeType || typeof mimeType !== "string") {
      throw new Error("autogeny_transcribe: 'mimeType' must be a non-empty string");
    }
    const transcript = await transcribeBase64({ audioBase64, mimeType });
    return { transcript };
  },
};

// ---------------------------------------------------------------------------
// installForCompany
// ---------------------------------------------------------------------------

const SKILL_MARKDOWN = `# Autogeny Speech-to-Text (STT)

Use the \`autogeny_transcribe\` tool to convert audio or video files to text
using the Autogeny platform's speech-to-text service.

## Tool: \`autogeny_transcribe\`

**Parameters:**
- \`audioBase64\` *(required, string)* — base64-encoded audio/video data (max ~50 MB)
- \`mimeType\` *(required, string)* — MIME type of the audio, e.g. \`audio/wav\`, \`audio/mpeg\`

**Returns:** \`{ transcript: string }\`

**Supported MIME types:** \`audio/wav\`, \`audio/mpeg\`, \`audio/mp4\`, \`audio/ogg\`,
\`audio/flac\`, \`audio/webm\`, \`video/mp4\`, \`video/webm\`

**Example:**
\`\`\`json
{
  "audioBase64": "<base64 bytes>",
  "mimeType": "audio/wav"
}
\`\`\`
`;

async function installForCompany(db: Db, companyId: string): Promise<void> {
  const existing = await db
    .select({ id: companySkills.id })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, SKILL_ID)))
    .then((rows) => rows[0] ?? null);

  const values = {
    companyId,
    key: SKILL_ID,
    slug: "autogeny-stt",
    name: "Autogeny Speech-to-Text",
    description: "Convert audio attachments to text using Google Cloud Speech / Whisper",
    markdown: SKILL_MARKDOWN,
    sourceType: "platform" as const,
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "full" as const,
    compatibility: "compatible" as const,
    fileInventory: [],
    metadata: { platform: true, skillId: SKILL_ID },
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(companySkills).set(values).where(eq(companySkills.id, existing.id));
  } else {
    await db.insert(companySkills).values(values);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const autogenySttSkill: PlatformSkill = {
  skillId: SKILL_ID,
  toolDefinitions,
  toolHandlers,
  installForCompany,
};
