/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_NAVME_POI_TYPE: string;
  readonly VITE_DEFAULT_MAP_CODE: string;
  readonly VITE_VIEW_IN_AR_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
