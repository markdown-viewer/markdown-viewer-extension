#!/usr/bin/env fibjs

import { build } from 'esbuild';
import { createBuildConfig } from './build-config.js';

// Production build only
console.log('� Building extension...\n');

try {
  const config = createBuildConfig();
  const result = await build(config);
  console.log('✅ Build complete');
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}
