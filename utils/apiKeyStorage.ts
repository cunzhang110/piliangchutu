import type { ServiceProvider } from "../types";

const STORAGE_KEYS: Record<ServiceProvider, string> = {
  yunwu: "yunwu_api_key",
  apimart: "apimart_api_key"
};

const canUseStorage = () => typeof window !== "undefined" && typeof window.localStorage !== "undefined";

export const getStoredApiKey = (provider: ServiceProvider) => {
  if (!canUseStorage()) return "";
  return window.localStorage.getItem(STORAGE_KEYS[provider])?.trim() || "";
};

export const saveStoredApiKey = (provider: ServiceProvider, apiKey: string) => {
  if (!canUseStorage()) return;
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    window.localStorage.removeItem(STORAGE_KEYS[provider]);
    return;
  }
  window.localStorage.setItem(STORAGE_KEYS[provider], normalizedKey);
};

export const clearStoredApiKey = (provider: ServiceProvider) => {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(STORAGE_KEYS[provider]);
};
