(function() {
'use strict';

// Hash gate: only activate on pages navigated to with #rc2jdt hash
if (!location.hash.startsWith('#rc2jdt')) return;

// --- DOM wipe (defense-in-depth) ---
// Abort the hoster document so its HTML/CSS cannot race with our UI.
try { window.stop(); } catch (e) { /* ignore */ }

// IMPORTANT: do NOT call document.open()/close(). That tears down the browsing
// frame mid-navigation and makes chrome.scripting.executeScript fail with
// "Frame with ID 0 was removed", so hCaptcha's api.js is never requested.
// Wipe the existing Document in place so the frame id stays stable, then
// reuse document.body (never append a second <body> — that orphans the UI).
var html = document.documentElement;
if (!html) {
    html = document.createElement('html');
    document.appendChild(html);
}
var head = document.head;
if (!head) {
    head = document.createElement('head');
    html.insertBefore(head, html.firstChild);
} else {
    while (head.firstChild) head.removeChild(head.firstChild);
}

var body = document.body;
if (!body) {
    body = document.createElement('body');
    html.appendChild(body);
} else {
    while (body.firstChild) body.removeChild(body.firstChild);
}
body.id = 'myjd-captcha-body';
body.style.background = '#3c686f';
body.style.color = '#fff';
body.style.fontFamily = 'Arial, sans-serif';
body.style.padding = '32px';
body.style.margin = '0';
var loadingMsg = document.createElement('div');
loadingMsg.textContent = 'Loading CAPTCHA solver...';
loadingMsg.style.textAlign = 'center';
loadingMsg.style.fontSize = '18px';
loadingMsg.style.marginTop = '40px';
body.appendChild(loadingMsg);

// Force the CAPTCHA UI visible on screen. Cloudflare anti-flicker CSS
// (html{visibility:hidden} with @media print{visibility:visible}) and leftover
// hoster opacity rules can leave a print-preview-only page even after we wipe
// <head> — the <html> element's inline/computed styles survive the wipe.
var forceCaptchaUiVisible = function() {
    var root = document.documentElement;
    if (root) {
        root.style.setProperty('visibility', 'visible', 'important');
        root.style.setProperty('opacity', '1', 'important');
        root.style.setProperty('display', 'block', 'important');
        root.style.setProperty('background', '#f5f5f5', 'important');
        root.removeAttribute('hidden');
        if (root.classList) {
            root.classList.remove('cf-invisible', 'no-js', 'js-loading');
        }
    }
    if (body) {
        body.style.setProperty('visibility', 'visible', 'important');
        body.style.setProperty('opacity', '1', 'important');
    }
    var headEl = document.head;
    if (headEl && !document.getElementById('myjd-captcha-visible')) {
        var style = document.createElement('style');
        style.id = 'myjd-captcha-visible';
        style.textContent = [
            'html, body, body#myjd-captcha-body {',
            '  visibility: visible !important;',
            '  opacity: 1 !important;',
            '  content-visibility: visible !important;',
            '}',
            'html { background: #f5f5f5 !important; }',
            'body#myjd-captcha-body {',
            '  color: #333 !important;',
            '  background: #f5f5f5 !important;',
            '  display: flex !important;',
            '}',
            '#myjd-captcha-body, #captchaContainer, #myjd-captcha-controls, #myjd-countdown {',
            '  visibility: visible !important;',
            '  opacity: 1 !important;',
            '}'
        ].join('\\n');
        headEl.appendChild(style);
    }
};
forceCaptchaUiVisible();


// Drop any extra <body> siblings that a late hoster parse may have inserted.
var removeForeignBodies = function() {
    var bodies = document.querySelectorAll('body');
    var k;
    for (k = 0; k < bodies.length; k++) {
        if (bodies[k].id !== 'myjd-captcha-body' && bodies[k].parentNode) {
            bodies[k].parentNode.removeChild(bodies[k]);
        }
    }
};

// Strategy 2: On readystatechange, clear foreign DOM (including extra bodies).
var clearDocument = function() {
    var html = document.documentElement;
    if (!html) return;
    var i;
    for (i = html.childNodes.length - 1; i >= 0; i--) {
        var child = html.childNodes[i];
        if (child.nodeName === 'BODY' && child.id === 'myjd-captcha-body') continue;
        if (child.nodeName === 'BODY') {
            html.removeChild(child);
            continue;
        }
        if (child.nodeName === 'HEAD') {
            // Keep CAPTCHA provider api.js if the MAIN-world injector parked it
            // in <head>; wiping it would undo myjd-captcha-load-api.
            var hchild = child.firstChild;
            while (hchild) {
                var next = hchild.nextSibling;
                var keepScript = hchild.nodeName === 'SCRIPT' && hchild.src &&
                    /hcaptcha\.com\/1\/api\.js|google\.com\/recaptcha\/api\.js/.test(hchild.src);
                var keepStyle = hchild.nodeName === 'STYLE' && hchild.id === 'myjd-captcha-visible';
                if (!keepScript && !keepStyle) child.removeChild(hchild);
                hchild = next;
            }
            forceCaptchaUiVisible();
            continue;
        }
        html.removeChild(child);
    }
};
document.addEventListener('readystatechange', clearDocument);

// Strategy 3: Remove foreign bodies on DOMContentLoaded — and immediately if
// we are already past 'loading' (so the event never fires).
var onDomReady = function() { removeForeignBodies(); };
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
} else {
    onDomReady();
}

// --- Interval handles for cleanup ---
var pollingHandle = null;
var countdownHandle = null;

// --- Read job data from chrome.storage.session ---
chrome.storage.session.get('myjd_captcha_job', function(result) {
    var job = result && result.myjd_captcha_job;
    if (!job) {
        while (body.firstChild) body.removeChild(body.firstChild);
        var errMsg = document.createElement('div');
        errMsg.textContent = 'No CAPTCHA job found. Please try again from the MyJDownloader web interface.';
        errMsg.style.textAlign = 'center';
        errMsg.style.fontSize = '16px';
        errMsg.style.marginTop = '40px';
        body.appendChild(errMsg);
        return;
    }
    renderCaptchaWidget(job);
});

/**
 * Render the CAPTCHA widget, skip buttons, countdown timer, and start token polling.
 */
function renderCaptchaWidget(job) {
    // Clear document head and body children — but keep a MAIN-world api.js
    // (and our visibility stylesheet) that may already have been injected.
    var head = document.head || document.getElementsByTagName('head')[0];
    if (head) {
        var hchild = head.firstChild;
        while (hchild) {
            var next = hchild.nextSibling;
            var keepScript = hchild.nodeName === 'SCRIPT' && hchild.src &&
                /hcaptcha\.com\/1\/api\.js|google\.com\/recaptcha\/api\.js/.test(hchild.src);
            var keepStyle = hchild.nodeName === 'STYLE' && hchild.id === 'myjd-captcha-visible';
            if (!keepScript && !keepStyle) head.removeChild(hchild);
            hchild = next;
        }
    }
    while (body.firstChild) body.removeChild(body.firstChild);
    forceCaptchaUiVisible();

    // Set page title
    document.title = 'CAPTCHA - ' + (job.hoster || 'JDownloader');

    // Restyle body for CAPTCHA display
    body.style.background = '#f5f5f5';
    body.style.color = '#333';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.alignItems = 'center';
    body.style.padding = '32px';
    body.style.maxWidth = '600px';
    body.style.margin = '0 auto';
    forceCaptchaUiVisible();

    // Header
    var header = document.createElement('h2');
    header.textContent = 'CAPTCHA for ' + (job.hoster || 'Unknown');
    header.style.marginBottom = '24px';
    header.style.color = '#333';
    body.appendChild(header);

    // CAPTCHA container
    var captchaContainer = document.createElement('div');
    captchaContainer.id = 'captchaContainer';
    captchaContainer.style.marginBottom = '20px';
    body.appendChild(captchaContainer);

    // Determine CAPTCHA type and create the widget div
    var isHcaptcha = job.captchaType && (job.captchaType.toLowerCase().indexOf('hcaptcha') !== -1);
    var widgetDiv = document.createElement('div');
    var apiScriptUrl;

    if (isHcaptcha) {
        widgetDiv.className = 'h-captcha';
        widgetDiv.setAttribute('data-sitekey', job.siteKey);
        apiScriptUrl = 'https://js.hcaptcha.com/1/api.js';
    } else {
        widgetDiv.className = 'g-recaptcha';
        widgetDiv.setAttribute('data-sitekey', job.siteKey);
        if (job.siteKeyType === 'INVISIBLE') {
            widgetDiv.setAttribute('data-size', 'invisible');
        }
        apiScriptUrl = 'https://www.google.com/recaptcha/api.js';
    }

    captchaContainer.appendChild(widgetDiv);

    // The provider's API script is loaded by the background service worker in
    // the page's MAIN world, not injected here: the isolated world content
    // scripts run in has its own CSP (script-src 'self' 'wasm-unsafe-eval'
    // ...), which blocks a remote <script src> appended from here regardless
    // of the page's own (already stripped) CSP header.
    var apiSettled = false;
    var apiTimeoutHandle;

    function settleApi(loaded) {
        if (apiSettled) return;
        apiSettled = true;
        window.removeEventListener('message', onApiMessage);
        clearTimeout(apiTimeoutHandle);
        if (loaded) {
            // For invisible/v3 CAPTCHAs, request MAIN world execution now that the API is ready
            if (job.siteKeyType === 'INVISIBLE') {
                chrome.runtime.sendMessage({
                    action: 'myjd-captcha-execute',
                    data: { siteKey: job.siteKey, v3action: job.v3action || '' }
                });
            }
        } else {
            showApiLoadError();
        }
    }

    function onApiMessage(event) {
        // event.source === window only scopes this listener to senders in
        // this exact window (filters out other frames/tabs) — it is NOT a
        // trust boundary: the hosting page runs in this same window (the tab
        // was navigated to job.targetUrl, whose own scripts keep running)
        // and could send a matching message itself. The status value we
        // read here carries no privilege though: it only steers this tab's
        // own CAPTCHA-loading UI, so a spoofed message can at worst confuse
        // this flow, not escalate into anything else. We use the same
        // window.postMessage bridge as cnlInterceptor.js purely for
        // consistency with the existing MAIN<->isolated world plumbing in
        // this codebase, not for its trust properties.
        if (event.source !== window) return;
        if (event.origin && event.origin !== window.location.origin) return;
        var data = event.data;
        if (!data || data.__myjd_captcha_api__ !== true) return;
        settleApi(data.status === 'loaded');
    }
    window.addEventListener('message', onApiMessage);

    // Fallback: if the background service worker rejects/fails to inject the
    // script, or the injected script never fires load/error at all, don't
    // leave the widget blank until the 5-minute countdown skips it. (The
    // background side posts with target origin '*', not
    // window.location.origin, specifically so an opaque-origin page — where
    // location.origin is the string "null" — can't turn this into a thrown
    // SyntaxError that silently drops the message.)
    apiTimeoutHandle = setTimeout(function() { settleApi(false); }, 15000);

    chrome.runtime.sendMessage({
        action: 'myjd-captcha-load-api',
        data: { url: apiScriptUrl }
    }, function(response) {
        if (chrome.runtime.lastError || !response || response.status !== 'ok') {
            settleApi(false);
        }
    });

    // --- Skip buttons ---
    injectSkipButtons(job);

    // --- Countdown timer ---
    startCountdown(job);

    // --- Token polling ---
    pollingHandle = startTokenPolling(job);
}

/**
 * Show an error message in the CAPTCHA container when the provider's API
 * script fails to load, instead of leaving a blank widget until the
 * 5-minute countdown auto-skips. The skip buttons stay usable.
 */
function showApiLoadError() {
    var container = document.getElementById('captchaContainer');
    if (!container) return;
    var errMsg = document.createElement('div');
    errMsg.textContent = 'Failed to load the CAPTCHA widget. Use a skip button below or try again.';
    errMsg.style.color = '#f44336';
    errMsg.style.fontSize = '14px';
    errMsg.style.marginTop = '12px';
    container.appendChild(errMsg);
}

/**
 * Inject skip buttons with extension-themed styling.
 * Uses event delegation on the container for MV3 CSP compliance.
 */
function injectSkipButtons(job) {
    var container = document.createElement('div');
    container.id = 'myjd-captcha-controls';
    container.style.display = 'flex';
    container.style.gap = '8px';
    container.style.flexWrap = 'wrap';
    container.style.justifyContent = 'center';
    container.style.marginTop = '16px';

    var buttons = [
        { type: 'hoster', label: 'Skip ' + (job.hoster || 'Hoster') + ' CAPTCHAs' },
        { type: 'package', label: 'Skip Package' },
        { type: 'all', label: 'Skip All' },
        { type: 'single', label: 'Skip This' }
    ];

    var j;
    for (j = 0; j < buttons.length; j++) {
        var btn = document.createElement('button');
        btn.textContent = buttons[j].label;
        btn.dataset.skipType = buttons[j].type;
        btn.style.padding = '8px 16px';
        btn.style.border = '1px solid #2196F3';
        btn.style.borderRadius = '4px';
        btn.style.background = '#fff';
        btn.style.color = '#2196F3';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '13px';

        btn.addEventListener('mouseenter', function() {
            this.style.background = '#2196F3';
            this.style.color = '#fff';
        });
        btn.addEventListener('mouseleave', function() {
            this.style.background = '#fff';
            this.style.color = '#2196F3';
        });

        container.appendChild(btn);
    }

    // Event delegation: single click listener on container
    container.addEventListener('click', function(e) {
        var skipType = e.target.dataset.skipType;
        if (skipType) {
            chrome.runtime.sendMessage({
                action: 'captcha-skip',
                data: {
                    callbackUrl: job.callbackUrl || 'MYJD',
                    captchaId: job.captchaId,
                    skipType: skipType
                }
            });
        }
    });

    body.appendChild(container);
}

/**
 * Poll for solved CAPTCHA tokens at 500ms interval.
 * Checks both reCAPTCHA and hCaptcha textareas.
 */
function startTokenPolling(job) {
    var handle = setInterval(function() {
        // reCAPTCHA: textarea id starts with "g-recaptcha-response"
        var recaptchaTextareas = document.querySelectorAll('textarea[id^="g-recaptcha-response"]');
        var i;
        for (i = 0; i < recaptchaTextareas.length; i++) {
            if (recaptchaTextareas[i].value && recaptchaTextareas[i].value.length > 30) {
                clearInterval(handle);
                pollingHandle = null;
                chrome.runtime.sendMessage({
                    action: 'captcha-solved',
                    data: {
                        token: recaptchaTextareas[i].value,
                        callbackUrl: job.callbackUrl || 'MYJD',
                        captchaId: job.captchaId,
                        deviceId: job.deviceId || null
                    }
                });
                return;
            }
        }

        // hCaptcha: textarea name is "h-captcha-response"
        var hcaptchaTextareas = document.querySelectorAll('textarea[name="h-captcha-response"]');
        for (i = 0; i < hcaptchaTextareas.length; i++) {
            if (hcaptchaTextareas[i].value && hcaptchaTextareas[i].value.length > 30) {
                clearInterval(handle);
                pollingHandle = null;
                chrome.runtime.sendMessage({
                    action: 'captcha-solved',
                    data: {
                        token: hcaptchaTextareas[i].value,
                        callbackUrl: job.callbackUrl || 'MYJD',
                        captchaId: job.captchaId,
                        deviceId: job.deviceId || null
                    }
                });
                return;
            }
        }
    }, 500);

    return handle;
}

/**
 * 5-minute countdown timer with visual urgency.
 * Sends skip(single) with the job's callback on expiry.
 */
function startCountdown(job) {
    var TIMEOUT_MS = 5 * 60 * 1000; // 300000ms = 5 minutes
    var startTime = Date.now();

    var timerEl = document.createElement('div');
    timerEl.id = 'myjd-countdown';
    timerEl.style.textAlign = 'center';
    timerEl.style.marginTop = '12px';
    timerEl.style.fontSize = '14px';
    timerEl.style.color = '#666';
    body.appendChild(timerEl);

    countdownHandle = setInterval(function() {
        var elapsed = Date.now() - startTime;
        var remaining = Math.max(0, TIMEOUT_MS - elapsed);
        var minutes = Math.floor(remaining / 60000);
        var seconds = Math.floor((remaining % 60000) / 1000);
        timerEl.textContent = 'Time remaining: ' + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;

        if (remaining < 60000) {
            timerEl.style.color = '#f44336';
            timerEl.style.fontWeight = 'bold';
        }

        if (remaining <= 0) {
            clearInterval(countdownHandle);
            countdownHandle = null;
            if (pollingHandle) {
                clearInterval(pollingHandle);
                pollingHandle = null;
            }
            timerEl.textContent = 'Timed out - skipping...';
            chrome.runtime.sendMessage({
                action: 'captcha-skip',
                data: {
                    callbackUrl: job.callbackUrl || 'MYJD',
                    captchaId: job.captchaId,
                    skipType: 'single'
                }
            });
        }
    }, 1000);
}

// Cleanup on unload to prevent memory leaks
window.addEventListener('beforeunload', function() {
    if (pollingHandle) clearInterval(pollingHandle);
    if (countdownHandle) clearInterval(countdownHandle);
});

})();
