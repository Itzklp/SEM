/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRAUD_API_URL: string;
  readonly VITE_REVIEW_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
