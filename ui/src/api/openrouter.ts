import { apiClient } from "./client.js";

export interface OpenRouterModel {
  id: string;
  label: string;
  free: boolean;
  contextLength: number;
  maxOutput: number;
  promptPrice: number;
  completionPrice: number;
}

export const openRouterApi = {
  models: () => apiClient.get<OpenRouterModel[]>("/openrouter/models"),
};
