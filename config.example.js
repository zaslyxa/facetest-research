window.EXPERIMENT_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY",
  supabaseTable: "experiment_responses",
  stimulusDurationMs: 3000,
  requireMinimumViewport: true,
  minimumViewportWidth: 760,
  minimumViewportHeight: 520,
  preloadConcurrency: 3,
  initialPreloadCount: 60,
  preloadLookaheadCount: 60,
  supabaseRequestAttempts: 8,
  supabaseRequestTimeoutMs: 15000,
  allowSetChoiceWhenMissingUrl: true,
  showDebugDownload: false
};
