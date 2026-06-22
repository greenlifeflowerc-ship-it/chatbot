// Provide a complete, dummy environment before any module imports config/env,
// which validates and would otherwise exit the process during tests.
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.META_VERIFY_TOKEN = 'test-verify-token';
process.env.IG_ACCESS_TOKEN = 'test-ig-token';
process.env.IG_APP_ID = 'test-ig-app-id';
process.env.IG_APP_SECRET = 'test-ig-app-secret';
process.env.IG_REDIRECT_URI = 'https://example.onrender.com/auth/instagram/callback';
process.env.IG_SETUP_SECRET = 'test-setup-secret';
process.env.LLM_MODEL = 'claude-sonnet-4-6';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
