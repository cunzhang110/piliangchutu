const STORAGE_KEY = "yunwu_api_key";

const canUseStorage = () => typeof window !== "undefined" && typeof window.localStorage !== "undefined";

export const getStoredApiKey = () => {
  if (!canUseStorage()) return "";
  return window.localStorage.getItem(STORAGE_KEY)?.trim() || "";
};

export const saveStoredApiKey = (apiKey: string) => {
  if (!canUseStorage()) return;
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, normalizedKey);
};

export const clearStoredApiKey = () => {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(STORAGE_KEY);
};
