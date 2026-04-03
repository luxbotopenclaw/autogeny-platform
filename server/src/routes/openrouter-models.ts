import { Router } from "express";
import { assertBoard } from "./authz.js";

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: { prompt: string; completion: string };
  context_length: number;
  top_provider: { context_length: number; max_completion_tokens: number } | null;
  architecture: { modality: string } | null;
}

export interface TransformedModel {
  id: string;
  label: string;
  free: boolean;
  contextLength: number;
  maxOutput: number;
  modality: string;
  promptPrice: number;
  completionPrice: number;
}

interface CachedModels {
  models: TransformedModel[];
  fetchedAt: number;
}

let cache: CachedModels | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function fetchModels(): Promise<TransformedModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter API returned ${res.status}`);

  const data = (await res.json()) as { data: OpenRouterModel[] };

  const models: TransformedModel[] = data.data
    .filter((m) => {
      const mod = m.architecture?.modality ?? "";
      return mod.includes("text");
    })
    .map((m) => {
      const promptPrice = parseFloat(m.pricing.prompt) || 0;
      const completionPrice = parseFloat(m.pricing.completion) || 0;
      const free = promptPrice === 0 && completionPrice === 0;
      return {
        id: m.id,
        label: `${m.name}${free ? " (Free)" : ""}`,
        free,
        contextLength: m.context_length,
        maxOutput: m.top_provider?.max_completion_tokens ?? 0,
        modality: m.architecture?.modality ?? "text->text",
        promptPrice,
        completionPrice,
      };
    })
    .sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  cache = { models, fetchedAt: Date.now() };
  return models;
}

export function openRouterModelRoutes() {
  const router = Router();

  router.get("/openrouter/models", assertBoard, async (_req, res) => {
    try {
      const models = await fetchModels();
      res.json(models);
    } catch (err) {
      res.status(502).json({
        error: "Failed to fetch OpenRouter models",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
