/** Supported NavMe tenant / POI languages (matches `navme_tenant_languages.lang_code`). */

export const NAVME_LANGUAGES = [
  { code: 'en', label: 'English', nativeLabel: 'English', apiCode: 'en' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español', apiCode: 'es' },
  { code: 'fr', label: 'French', nativeLabel: 'Français', apiCode: 'fr' },
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية', apiCode: 'ar' },
  { code: 'zh', label: 'Chinese (Simplified)', nativeLabel: '中文', apiCode: 'zh-CN' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語', apiCode: 'ja' },
  { code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी', apiCode: 'hi' },
  { code: 'kn', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ', apiCode: 'kn' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português', apiCode: 'pt' },
  { code: 'ta', label: 'Tamil', nativeLabel: 'தமிழ்', apiCode: 'ta' },
  { code: 'te', label: 'Telugu', nativeLabel: 'తెలుగు', apiCode: 'te' },
  { code: 'ml', label: 'Malayalam', nativeLabel: 'മലയാളം', apiCode: 'ml' },
  { code: 'bn', label: 'Bengali', nativeLabel: 'বাংলা', apiCode: 'bn' },
];

export const NAVME_LANGUAGE_BY_CODE = Object.fromEntries(
  NAVME_LANGUAGES.map((lang) => [lang.code, lang]),
);
