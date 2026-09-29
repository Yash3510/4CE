import { defineConfig } from 'wxt';

// One codebase, two browsers: `npm run build` (Chrome MV3) and `npm run build:firefox` (Firefox MV2).
export default defineConfig({
  // No symlinks in node_modules (npm flat install); keeping paths as-is lets the build run from a
  // short `subst` drive when the real folder path is longer than Windows' 260-character limit.
  vite: () => ({ resolve: { preserveSymlinks: true } }),
  manifest: ({ browser }) => ({
    name: 'Parda — privacy-first browser agent',
    description: 'A browser agent whose planner never sees your personal data: PII is found and redacted on the device, and filled back in locally.',
    permissions: ['activeTab', 'tabs', 'storage', ...(browser === 'firefox' ? [] : ['scripting', 'sidePanel'])],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Parda' },
    content_security_policy:
      browser === 'firefox'
        ? ("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" as any)
        : { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            // Redacted page content goes to the server the user configures; declared as website content.
            gecko: { id: 'parda@sih26171.local', strict_min_version: '142.0', data_collection_permissions: { required: ['websiteContent'] } },
          },
        }
      : {}),
  }),
});
