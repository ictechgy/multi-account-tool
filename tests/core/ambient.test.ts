import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectAmbientWarnings, formatAmbientWarnings } from '../../src/core/ambient.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('ambient warnings — shared detector', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('detects env names without including env values', async () => {
    const warnings = await detectAmbientWarnings('codex', {
      cwd: tmp.home,
      env: { OPENAI_API_KEY: 'sk-secret-value-must-not-appear' }
    });
    const serialized = JSON.stringify(warnings);

    expect(warnings.map((w) => w.code)).toContain('ambient.env');
    expect(serialized).toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('sk-secret-value-must-not-appear');
  });

  it('detects env names by key presence without reading env values', async () => {
    const env = {};
    Object.defineProperty(env, 'OPENAI_API_KEY', {
      enumerable: true,
      get() {
        throw new Error('env value was read');
      }
    });

    const warnings = await detectAmbientWarnings('codex', {
      cwd: tmp.home,
      env: env as NodeJS.ProcessEnv
    });

    expect(warnings.map((w) => w.code)).toContain('ambient.env');
    expect(JSON.stringify(warnings)).toContain('OPENAI_API_KEY');
  });

  it('detects Grok env bypass channels without reading values or duplicating GROK_HOME', async () => {
    const env = {
      XAI_API_KEY: 'xai-secret-value-must-not-appear',
      GROK_HOME: '/tmp/grok-home-secret-value-must-not-appear',
      GROK_OIDC_TOKEN: 'oidc-secret-value-must-not-appear'
    };

    const warnings = await detectAmbientWarnings('grok', { cwd: tmp.home, env });
    const serialized = JSON.stringify(warnings);

    expect(warnings.map((w) => w.name)).toEqual(
      expect.arrayContaining(['XAI_API_KEY', 'GROK_HOME', 'GROK_OIDC_TOKEN'])
    );
    expect(warnings.filter((w) => w.name === 'GROK_HOME')).toHaveLength(1);
    expect(serialized).not.toContain('xai-secret-value-must-not-appear');
    expect(serialized).not.toContain('grok-home-secret-value-must-not-appear');
    expect(serialized).not.toContain('oidc-secret-value-must-not-appear');
  });

  it('detects Goose HF_TOKEN without reading or exposing its value', async () => {
    const env = {};
    Object.defineProperty(env, 'HF_TOKEN', {
      enumerable: true,
      get() {
        throw new Error('HF_TOKEN value was read');
      }
    });

    const warnings = await detectAmbientWarnings('goose', {
      cwd: tmp.home,
      env: env as NodeJS.ProcessEnv
    });

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ambient.env', cliId: 'goose', name: 'HF_TOKEN' })
    ]));
    expect(JSON.stringify(warnings)).not.toContain('value was read');
  });

  it('detects current Qwen v0.19.10 static provider env channels', async () => {
    const warnings = await detectAmbientWarnings('qwen', {
      cwd: tmp.home,
      env: {
        BAILIAN_CODING_PLAN_API_KEY: 'secret-a',
        XAI_API_KEY: 'secret-b',
        QWEN_CUSTOM_API_KEY_TEAM: 'secret-c'
      }
    });
    const serialized = JSON.stringify(warnings);

    expect(warnings.map((warning) => warning.name)).toEqual(expect.arrayContaining([
      'BAILIAN_CODING_PLAN_API_KEY',
      'XAI_API_KEY',
      'QWEN_CUSTOM_API_KEY_TEAM'
    ]));
    expect(serialized).not.toContain('secret-a');
    expect(serialized).not.toContain('secret-b');
    expect(serialized).not.toContain('secret-c');
  });

  it('detects env prefixes and redacts long env names', async () => {
    const longKey = 'AIDER_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';
    const warnings = await detectAmbientWarnings('aider', {
      cwd: tmp.home,
      env: { [longKey]: 'present' }
    });

    expect(JSON.stringify(warnings)).not.toContain('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz');
    expect(warnings[0].code).toBe('ambient.env');
  });

  it('checks cwd entries by metadata only and reports symlink kind', async () => {
    const secretTarget = join(tmp.home, 'secret-target');
    await fs.writeFile(secretTarget, 'secret-file-content-must-not-appear');
    await fs.symlink(secretTarget, join(tmp.home, '.env'));

    const warnings = await detectAmbientWarnings('aider', { cwd: tmp.home, env: {} });
    const serialized = JSON.stringify(warnings);

    expect(serialized).toContain('.env');
    expect(serialized).toContain('symlink');
    expect(serialized).not.toContain('secret-file-content-must-not-appear');
  });

  it('detects project-local Grok config directory by metadata only', async () => {
    const secretTarget = join(tmp.home, 'grok-secret-target');
    await fs.writeFile(secretTarget, 'grok-project-secret-must-not-appear');
    await fs.symlink(secretTarget, join(tmp.home, '.grok'));

    const warnings = await detectAmbientWarnings('grok', { cwd: tmp.home, env: {} });
    const serialized = JSON.stringify(warnings);

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ambient.cwd', cliId: 'grok', name: '.grok', detail: 'symlink' })
    ]));
    expect(serialized).not.toContain('grok-project-secret-must-not-appear');
  });

  it('returns no warnings for unknown CLIs', async () => {
    await expect(detectAmbientWarnings('unknown', { cwd: tmp.home, env: { OPENAI_API_KEY: 'x' } })).resolves.toEqual([]);
  });

  it('does not throw when the current working directory cannot be resolved', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd unavailable');
    });

    try {
      const warnings = await detectAmbientWarnings('aider', {
        env: { AIDER_MODEL: 'secret-value-must-not-appear' }
      });
      const serialized = JSON.stringify(warnings);

      expect(warnings.map((w) => w.code)).toContain('ambient.env');
      expect(warnings.map((w) => w.code)).toContain('ambient.cwd.unreadable');
      expect(serialized).toContain('AIDER_MODEL');
      expect(serialized).not.toContain('secret-value-must-not-appear');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('warns on ANTHROPIC_BASE_URL for claude — 목적지 재지정도 격리 경계다', async () => {
    // z.ai GLM Coding Plan 같은 env 전용 통합은 이 변수로 세션 전체를 다른 provider/계정으로
    // 보낸다. 토큰만 경고하고 이걸 놓치면 mat 의 "프로필 swap 성공" 보고가 사실과 어긋난다.
    const warnings = await detectAmbientWarnings('claude', {
      cwd: tmp.home,
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
    });
    const serialized = JSON.stringify(warnings);

    expect(serialized).toContain('ANTHROPIC_BASE_URL');
    expect(serialized).not.toContain('api.z.ai');
  });

  it('does not warn on ANTHROPIC_DEFAULT_*_MODEL — mat 은 claude routing 아티팩트를 캡처하지 않는다', async () => {
    const warnings = await detectAmbientWarnings('claude', {
      cwd: tmp.home,
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air'
      }
    });

    expect(warnings.filter((w) => w.channel === 'env')).toHaveLength(0);
  });

  it('warns on ANTHROPIC_HOST for goose — ANTHROPIC_BASE_URL 이 아니라 이 이름이다', async () => {
    // goose 의 anthropic provider 는 config.get_param("ANTHROPIC_HOST") 를 읽고
    // get_param 은 env 를 config.yaml 보다 우선한다 → 캡처된 goose-config.yaml 을 덮어쓴다.
    const hostWarnings = await detectAmbientWarnings('goose', {
      cwd: tmp.home,
      env: { ANTHROPIC_HOST: 'https://api.z.ai/api/anthropic' }
    });
    expect(JSON.stringify(hostWarnings)).toContain('ANTHROPIC_HOST');

    // goose 가 읽지 않는 이름으로 거짓 경고를 내지 않는다.
    const baseUrlWarnings = await detectAmbientWarnings('goose', {
      cwd: tmp.home,
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
    });
    expect(baseUrlWarnings.filter((w) => w.channel === 'env')).toHaveLength(0);
  });

  it('warns on the goose config-dir resolver inputs that would silently void every fixed path', async () => {
    for (const name of ['GOOSE_PATH_ROOT', 'XDG_CONFIG_HOME']) {
      const warnings = await detectAmbientWarnings('goose', { cwd: tmp.home, env: { [name]: '/tmp/relocated' } });
      expect(JSON.stringify(warnings), name).toContain(name);
    }
  });

  it('formats a warning-only block', async () => {
    const warnings = await detectAmbientWarnings('codex', {
      cwd: tmp.home,
      env: { CODEX_HOME: '/tmp/codex' }
    });
    const text = formatAmbientWarnings(warnings, { header: 'Header' });

    expect(text).toMatch(/Header/);
    expect(text).toMatch(/CODEX_HOME/);
    expect(text).toMatch(/continues/);
  });
});
