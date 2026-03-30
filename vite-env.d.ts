/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_YUNWU_API_KEY?: string;
  readonly VITE_YUNWU_BASE_URL?: string;
  readonly VITE_YUNWU_IMAGE_MODEL?: string;
  readonly VITE_YUNWU_TEXT_MODEL?: string;
  readonly VITE_YUNWU_ENABLE_PROMPT_REWRITE?: string;
  readonly VITE_YUNWU_MIN_REQUEST_INTERVAL_MS?: string;
  readonly VITE_YUNWU_MAX_RATE_LIMIT_RETRIES?: string;
  readonly VITE_YUNWU_RATE_LIMIT_COOLDOWN_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
