#!/usr/bin/env node
/**
 * mat — Multi-Account Tool 의 bin 진입점.
 * Ink 앱을 렌더링한다.
 */

import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { migrateLegacyDataDir } from './core/migrate.js';

// v0.1 (~/.multi-sub-terminal) → v0.2 (~/.multi-account-tool) 일회성 데이터 마이그레이션.
// render() 전에 호출해 stderr 안내가 Ink TUI 화면을 깨지 않게 한다.
migrateLegacyDataDir();

const { waitUntilExit } = render(<App />);
waitUntilExit().catch(() => {
  process.exit(1);
});
