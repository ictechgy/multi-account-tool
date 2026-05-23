#!/usr/bin/env node
/**
 * mat — Multi-Subscription Terminal 의 bin 진입점.
 * Ink 앱을 렌더링한다.
 */

import React from 'react';
import { render } from 'ink';
import App from './app.js';

const { waitUntilExit } = render(<App />);
waitUntilExit().catch(() => {
  process.exit(1);
});
