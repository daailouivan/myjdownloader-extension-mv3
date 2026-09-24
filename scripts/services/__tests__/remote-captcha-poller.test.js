'use strict';

const fs = require('fs');
const path = require('path');

const bgSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'background.js'), 'utf8'
);
const offscreenSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'offscreen.js'), 'utf8'
);

function extractFunction(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const startMatch = source.match(re);
  if (!startMatch) throw new Error('function not found: ' + name);
  const start = startMatch.index;
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return source.slice(start, i);
}

describe('Remote MyJD captcha poller', () => {
  describe('jobDetails mapping (mapCaptchaJobToDetails)', () => {
    const mapCaptchaJobToDetails = new Function(
      'return (' + extractFunction(bgSource, 'mapCaptchaJobToDetails') + ');'
    )();

    it('maps list job + rawtoken challenge into the Rc2Service jobDetails shape', () => {
      const details = mapCaptchaJobToDetails(
        { id: 42, hoster: 'upstore.net', type: 'hcaptcha', challengeType: 'hcaptcha' },
        { siteKey: 'site-key-abc', type: 'NORMAL', siteUrl: 'https://upstore.net/file/xyz', v3Action: null },
        'device-1'
      );
      expect(details).toEqual({
        captchaId: 42,
        captchaType: 'hcaptcha',
        hoster: 'upstore.net',
        siteKey: 'site-key-abc',
        siteKeyType: 'NORMAL',
        v3action: null,
        targetUrl: 'https://upstore.net/file/xyz',
        callbackUrl: 'MYJD',
        deviceId: 'device-1'
      });
    });

    it('falls back to contextUrl when siteUrl is missing', () => {
      const details = mapCaptchaJobToDetails(
        { id: 7, hoster: 'ddownload.com', type: 'recaptchav2' },
        { siteKey: 'k', type: 'NORMAL', contextUrl: 'https://ddownload.com/d/1' },
        'dev'
      );
      expect(details.targetUrl).toBe('https://ddownload.com/d/1');
    });
  });

  describe('browser-solvable filter', () => {
    const isBrowserSolvableCaptcha = new Function(
      'return (' + extractFunction(bgSource, 'isBrowserSolvableCaptcha') + ');'
    )();

    it('accepts hcaptcha with siteKey and targetUrl', () => {
      expect(isBrowserSolvableCaptcha({
        captchaType: 'hcaptcha', siteKey: 'k', targetUrl: 'https://x.com'
      })).toBe(true);
    });

    it('accepts recaptchav2 with siteKey and targetUrl', () => {
      expect(isBrowserSolvableCaptcha({
        captchaType: 'recaptchav2', siteKey: 'k', targetUrl: 'https://x.com'
      })).toBe(true);
    });

    it('rejects challenges without a siteKey (image captchas)', () => {
      expect(isBrowserSolvableCaptcha({
        captchaType: 'BasicCaptcha', siteKey: null, targetUrl: 'https://x.com'
      })).toBe(false);
    });
  });

  describe('prepareCaptchaTab creates a tab when tabId is missing', () => {
    it('source calls chrome.tabs.create when tabId is null', () => {
      expect(bgSource).toMatch(/tabs\.create\(\s*\{\s*url:\s*'about:blank'/);
      expect(bgSource).toMatch(/tabId == null \|\| tabId < 0/);
    });

    it('still uses tabs.update with #rc2jdt for existing tabs', () => {
      expect(bgSource).toMatch(/chrome\.tabs\.update\(tabId,\s*\{\s*url:\s*jobDetails\.targetUrl\s*\+\s*'#rc2jdt'\s*\}\)/);
    });
  });

  describe('dedupe / cooldown', () => {
    it('tracks remoteCaptchaOpen and remoteCaptchaCooldown', () => {
      expect(bgSource).toMatch(/const remoteCaptchaOpen = \{\}/);
      expect(bgSource).toMatch(/const remoteCaptchaCooldown = \{\}/);
      expect(bgSource).toMatch(/REMOTE_CAPTCHA_COOLDOWN_MS/);
      expect(bgSource).toMatch(/function markRemoteCaptchaClosed/);
      expect(bgSource).toMatch(/function findTabIdForCaptcha/);
    });

    it('skips captchas that already have a tab or are on cooldown', () => {
      expect(bgSource).toMatch(/findTabIdForCaptcha\(captchaId\)/);
      expect(bgSource).toMatch(/isCaptchaOnCooldown\(captchaId\)/);
    });
  });

  describe('MyJD solve via device API', () => {
    it('exposes solveCaptchaViaMyJdApi that calls offscreen-captcha-solve', () => {
      expect(bgSource).toMatch(/function solveCaptchaViaMyJdApi/);
      expect(bgSource).toMatch(/offscreen-captcha-solve/);
    });

    it('captcha-solved MYJD path prefers the device API before web UI tabs', () => {
      const solved = bgSource.match(/action\s*===\s*["']captcha-solved["'][\s\S]*?action\s*===\s*["']captcha-skip["']/);
      expect(solved).not.toBeNull();
      expect(solved[0]).toMatch(/solveCaptchaViaMyJdApi/);
      expect(solved[0]).toMatch(/my\.jdownloader\.org/);
    });
  });

  describe('offscreen captcha handlers use jdapi device path', () => {
    it('defines list/get/solve handlers', () => {
      expect(offscreenSource).toMatch(/offscreen-captcha-list/);
      expect(offscreenSource).toMatch(/offscreen-captcha-get/);
      expect(offscreenSource).toMatch(/offscreen-captcha-solve/);
    });

    it('routes through setActiveDevice + api.send (not hardcoded api.jdownloader.org)', () => {
      expect(offscreenSource).toMatch(/function sendCaptchaDeviceCall/);
      expect(offscreenSource).toMatch(/api\.setActiveDevice\(deviceId\)/);
      expect(offscreenSource).toMatch(/api\.send\(action,\s*params\)/);
      const captchaSection = offscreenSource.slice(offscreenSource.indexOf('sendCaptchaDeviceCall'));
      expect(captchaSection).not.toMatch(/https:\/\/api\.jdownloader\.org\/captcha/);
    });

    it('retries via relay after clearing localURL on direct-path failure', () => {
      expect(offscreenSource).toMatch(/setLocalURL\(null\)/);
      expect(offscreenSource).toMatch(/retrying via cloud relay/);
    });

    it('uses /captcha/list, /captcha/getCaptchaJob, /captcha/get rawtoken, /captcha/solve', () => {
      expect(offscreenSource).toMatch(/\/captcha\/list/);
      expect(offscreenSource).toMatch(/\/captcha\/getCaptchaJob/);
      expect(offscreenSource).toMatch(/'rawtoken'/);
      expect(offscreenSource).toMatch(/\/captcha\/solve/);
    });
  });

  describe('alarm / setting', () => {
    it('registers a remoteCaptchaPoll alarm at the MV3 1-minute floor', () => {
      expect(bgSource).toMatch(/REMOTE_CAPTCHA_ALARM\s*=\s*['"]remoteCaptchaPoll['"]/);
      expect(bgSource).toMatch(/REMOTE_CAPTCHA_PERIOD_MINUTES\s*=\s*1/);
      expect(bgSource).toMatch(/ensureRemoteCaptchaAlarm/);
    });

    it('respects AUTO_OPEN_REMOTE_CAPTCHA setting', () => {
      expect(bgSource).toMatch(/AUTO_OPEN_REMOTE_CAPTCHA/);
      expect(bgSource).toMatch(/AUTO_OPEN_REMOTE_CAPTCHA\] === false\) return/);
    });
  });
});
