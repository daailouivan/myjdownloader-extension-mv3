'use strict';

var fs = require('fs');
var path = require('path');

var csSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'contentscripts', 'myjdCaptchaSolver.js'), 'utf8'
);

var manifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'manifest.json'), 'utf8'
));

describe('MYJD CAPTCHA Solver Content Script', function() {

  describe('Hash gate', function() {
    it('should exit immediately if no #rc2jdt hash', function() {
      expect(csSource).toMatch(/#rc2jdt/);
      expect(csSource).toMatch(/return/);
    });
    it('should use IIFE pattern', function() {
      expect(csSource).toMatch(/^\(function\(\)\s*\{/);
    });
    it('should use var declarations', function() {
      // Check for var, not let/const in code lines
      var lines = csSource.split('\n').filter(function(l) {
        var t = l.trim();
        return t && t.indexOf('//') !== 0 && t.indexOf('*') !== 0;
      });
      var usesLetConst = lines.some(function(l) { return /^\s*(let|const)\s+/.test(l); });
      expect(usesLetConst).toBe(false);
    });
  });

  describe('DOM wipe', function() {
    it('must not call document.open/close (tears down the frame; api.js never loads)', function() {
      expect(csSource).not.toMatch(/^\s*document\.open\s*\(/m);
      expect(csSource).not.toMatch(/^\s*document\.close\s*\(/m);
    });
    it('should document the Frame-with-ID-0 failure mode', function() {
      expect(csSource).toMatch(/Frame with ID 0 was removed/);
    });
    it('should reuse document.body instead of appending a second body', function() {
      expect(csSource).toMatch(/var body = document\.body/);
      expect(csSource).toMatch(/body\.id = 'myjd-captcha-body'/);
      // Must not createElement('body') as the primary path — that caused the blank tab.
      expect(csSource).toMatch(/if \(!body\)/);
    });
    it('should ensure a <head> exists for the MAIN-world api.js injector', function() {
      expect(csSource).toMatch(/document\.head/);
      expect(csSource).toMatch(/createElement\('head'\)/);
    });
    it('should have clearDocument defense that removes foreign bodies', function() {
      expect(csSource).toMatch(/clearDocument/);
      expect(csSource).toMatch(/removeForeignBodies/);
    });
    it('should preserve CAPTCHA api.js scripts when clearing <head>', function() {
      expect(csSource).toMatch(/hcaptcha\.com\/1\/api\.js/);
    });
    it('should have DOMContentLoaded defense for foreign body removal', function() {
      expect(csSource).toMatch(/DOMContentLoaded/);
      expect(csSource).toMatch(/myjd-captcha-body/);
    });
    it('should call window.stop to abort the hoster document race', function() {
      expect(csSource).toMatch(/window\.stop/);
    });
  });

  describe('Session storage', function() {
    it('should read myjd_captcha_job from chrome.storage.session', function() {
      expect(csSource).toMatch(/chrome\.storage\.session\.get/);
      expect(csSource).toMatch(/myjd_captcha_job/);
    });
  });

  describe('Widget rendering', function() {
    it('should create g-recaptcha div for reCAPTCHA', function() {
      expect(csSource).toMatch(/g-recaptcha/);
      expect(csSource).toMatch(/data-sitekey/);
    });
    it('should create h-captcha div for hCaptcha', function() {
      expect(csSource).toMatch(/h-captcha/);
    });
    it('should know the reCAPTCHA API script URL', function() {
      expect(csSource).toMatch(/google\.com\/recaptcha\/api\.js/);
    });
    it('should know the hCaptcha API script URL (canonical js.hcaptcha.com CDN)', function() {
      expect(csSource).toMatch(/js\.hcaptcha\.com\/1\/api\.js/);
    });
    it('should handle invisible/v3 with data-size invisible', function() {
      expect(csSource).toMatch(/data-size.*invisible|invisible.*data-size/);
    });
    it('should request MAIN world execution for invisible CAPTCHAs', function() {
      expect(csSource).toMatch(/myjd-captcha-execute/);
    });
    it('should ask the background service worker to load the API script instead of injecting it itself', function() {
      // The isolated world's own CSP blocks a remote <script src> appended
      // directly from the content script, so loading happens in background.js
      // (MAIN world) instead.
      expect(csSource).toMatch(/myjd-captcha-load-api/);
      expect(csSource).not.toMatch(/createElement\(\s*['"]script['"]\s*\)/);
    });
    it('should listen for the postMessage bridge from the MAIN world and check event.source', function() {
      expect(csSource).toMatch(/addEventListener\(\s*['"]message['"]/);
      expect(csSource).toMatch(/__myjd_captcha_api__/);
      expect(csSource).toMatch(/event\.source\s*!==\s*window/);
    });
    it('should fall back to showApiLoadError on a rejected load-api response or timeout', function() {
      expect(csSource).toMatch(/function\s+showApiLoadError\s*\(/);
      expect(csSource).toMatch(/setTimeout\(\s*function\s*\(\)\s*\{\s*settleApi\(false\)/);
      expect(csSource).toMatch(/response\.status\s*!==\s*['"]ok['"]/);
      expect(csSource).toMatch(/chrome\.runtime\.lastError/);
    });
  });

  describe('Skip buttons', function() {
    it('should have all 4 skip types', function() {
      expect(csSource).toMatch(/hoster/);
      expect(csSource).toMatch(/package/);
      expect(csSource).toMatch(/single/);
    });
    it('should use event delegation', function() {
      expect(csSource).toMatch(/dataset\.skipType/);
    });
  });

  describe('Token polling', function() {
    it('should poll g-recaptcha-response', function() {
      expect(csSource).toMatch(/g-recaptcha-response/);
    });
    it('should poll h-captcha-response', function() {
      expect(csSource).toMatch(/h-captcha-response/);
    });
    it('should use 500ms interval', function() {
      expect(csSource).toMatch(/500/);
    });
  });

  describe('MYJD messaging', function() {
    it('should send captcha-solved with MYJD callbackUrl', function() {
      expect(csSource).toMatch(/captcha-solved/);
      expect(csSource).toMatch(/MYJD/);
    });
    it('should send captcha-skip with MYJD callbackUrl', function() {
      expect(csSource).toMatch(/captcha-skip/);
    });
    it('should include captchaId in messages', function() {
      expect(csSource).toMatch(/captchaId/);
    });
  });

  describe('Countdown', function() {
    it('should have 5-minute timeout', function() {
      var has300000 = csSource.indexOf('300000') !== -1;
      var has5x60x1000 = csSource.indexOf('5 * 60 * 1000') !== -1;
      expect(has300000 || has5x60x1000).toBe(true);
    });
    it('should auto-skip single on expiry', function() {
      expect(csSource).toMatch(/single/);
    });
  });

  describe('Manifest registration', function() {
    var entry;
    beforeAll(function() {
      entry = manifest.content_scripts.find(function(e) {
        return e.js && e.js.includes('contentscripts/myjdCaptchaSolver.js');
      });
    });
    it('should be registered in manifest', function() {
      expect(entry).toBeDefined();
    });
    it('should match all URLs', function() {
      expect(entry.matches).toContain('*://*/*');
    });
    it('should run at document_start', function() {
      expect(entry.run_at).toBe('document_start');
    });
    it('should have all_frames false', function() {
      expect(entry.all_frames).toBe(false);
    });
  });

  describe('Cleanup', function() {
    it('should clean up on beforeunload', function() {
      expect(csSource).toMatch(/beforeunload/);
    });
  });
});
