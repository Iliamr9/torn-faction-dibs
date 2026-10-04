// ==UserScript==
// @name         Torn Faction Dibs
// @namespace    torn-faction-dibs
// @version      3.0.0
// @description  Live Torn faction-war dibs tracking with chat catch-up, target highlighting, swapping, and automatic clearing.
// @author       Faction Tools
// @match        https://www.torn.com/*
// @homepageURL  https://github.com/Iliamr9/torn-faction-dibs
// @supportURL   https://github.com/Iliamr9/torn-faction-dibs/issues
// @updateURL    https://raw.githubusercontent.com/Iliamr9/torn-faction-dibs/main/torn-faction-dibs.user.js
// @downloadURL  https://raw.githubusercontent.com/Iliamr9/torn-faction-dibs/main/torn-faction-dibs.user.js
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '3.0.0';
    const STORAGE_KEY = 'torn_dibs_safe_state_v2';
    const API_KEY_STORAGE = 'torn_dibs_safe_api_key_v2';
    const API_BASE = 'https://api.torn.com/v2';

    // Deliberately conservative intervals. The old script was doing far too much work.
    const CHAT_SCAN_MS = 700;
    const CHAT_CATCHUP_LIMIT = 50;
    const TARGET_SCAN_MS = 1500;
    const FALLEN_SCAN_MS = 1000;
    const ATTACK_CHECK_MS = 20000;
    const STATUS_CHECK_MS = 2000;
    const API_PAGE_LIMIT = 100;
    const MAX_STARTUP_PAGES = 3;

    const CLEAR_RESULTS = new Set([
        'Attacked',
        'Mugged',
        'Hospitalized',
        'Arrested',
        'Looted',
        'Special',
        'Bounty',
        'Assist',
        'Interrupted'
    ]);

    const targetById = new Map();
    const targetIdByName = new Map();
    const processedMessageKeys = new Set();
    const processedMessageKeyQueue = [];
    const MAX_MESSAGE_KEYS = 1500;

    let lastStateRaw = '';
    let state = loadState();
    hydrateProcessedMessageKeys();
    let apiCheckRunning = false;
    let startupCatchupDone = false;
    let lastApiError = '';
    let panelOpen = false;
    let chatObserver = null;
    let observedChatRoot = null;
    let chatScanQueued = false;
    let statusCheckRunning = false;
    let statusCursor = 0;

    GM_addStyle(`
        .torn-dibs-target {
            background: linear-gradient(90deg, rgba(255, 171, 0, .28), rgba(255, 82, 82, .18)) !important;
            color: #ffd166 !important;
            border-radius: 4px !important;
            box-shadow: 0 0 0 1px rgba(255, 193, 7, .75), 0 0 9px rgba(255, 152, 0, .42) !important;
            padding: 1px 4px !important;
            text-decoration: none !important;
        }
        .torn-dibs-badge {
            display: inline-block;
            margin-left: 5px;
            padding: 1px 5px;
            border-radius: 9px;
            background: #ff9800;
            color: #111;
            font-size: 10px;
            line-height: 16px;
            font-weight: 800;
            vertical-align: middle;
            white-space: nowrap;
            pointer-events: none;
        }

        /* Faction member list: draw the reservation directly over the player's name banner.
           This avoids Torn's clipped/virtualized row layout hiding an inserted badge. */
        a.torn-dibs-faction-list-target {
            position: relative !important;
            overflow: visible !important;
            outline: 2px solid rgba(255, 183, 0, .95) !important;
            outline-offset: 1px !important;
            border-radius: 4px !important;
        }
        a.torn-dibs-faction-list-target::after {
            content: attr(data-dibs-list-label);
            position: absolute !important;
            right: 3px !important;
            top: 50% !important;
            transform: translateY(-50%) !important;
            z-index: 2147483646 !important;
            box-sizing: border-box !important;
            max-width: 72% !important;
            padding: 2px 6px !important;
            border: 1px solid rgba(0,0,0,.65) !important;
            border-radius: 9px !important;
            background: #ffb000 !important;
            color: #151515 !important;
            font: 800 10px/14px Arial, sans-serif !important;
            letter-spacing: .15px !important;
            white-space: nowrap !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            pointer-events: none !important;
            box-shadow: 0 1px 4px rgba(0,0,0,.55) !important;
        }
        .torn-dibs-faction-list-row {
            box-shadow: inset 3px 0 0 #ffb000 !important;
        }

        /* A profile page does not link the player name to itself, so the normal
           profile-link highlighter cannot see it. Mark the visible profile heading too. */
        .torn-dibs-profile-heading {
            overflow: visible !important;
        }
        .torn-dibs-profile-badge {
            display: inline-block !important;
            margin-left: 8px !important;
            padding: 2px 8px !important;
            border: 1px solid rgba(0,0,0,.65) !important;
            border-radius: 10px !important;
            background: #ffb000 !important;
            color: #151515 !important;
            font: 800 11px/16px Arial, sans-serif !important;
            letter-spacing: .15px !important;
            vertical-align: middle !important;
            white-space: nowrap !important;
            box-shadow: 0 1px 4px rgba(0,0,0,.55) !important;
            pointer-events: none !important;
        }
        #torn-dibs-pill {
            position: fixed;
            left: 10px;
            bottom: 10px;
            z-index: 1000000;
            border: 1px solid #555;
            border-radius: 16px;
            padding: 5px 10px;
            background: rgba(20,20,20,.95);
            color: #ddd;
            font: 600 11px/1.2 Arial, sans-serif;
            cursor: pointer;
            box-shadow: 0 2px 10px rgba(0,0,0,.4);
            user-select: none;
        }
        #torn-dibs-pill:hover { border-color: #ff9800; color: #fff; }
        #torn-dibs-pill .ok { color: #78d381; }
        #torn-dibs-pill .warn { color: #ffb74d; }
        #torn-dibs-pill .bad { color: #ff6b6b; }

        #torn-dibs-panel {
            position: fixed;
            left: 10px;
            bottom: 44px;
            z-index: 1000001;
            width: 340px;
            max-height: 65vh;
            overflow: auto;
            box-sizing: border-box;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 12px;
            background: rgba(18,18,18,.98);
            color: #ddd;
            font: 12px/1.4 Arial, sans-serif;
            box-shadow: 0 8px 30px rgba(0,0,0,.55);
        }
        #torn-dibs-panel h3 { margin: 0 0 10px; font-size: 14px; color: #fff; }
        #torn-dibs-panel label { display:block; margin: 8px 0 4px; color:#aaa; }
        #torn-dibs-panel input {
            width:100%; box-sizing:border-box; border:1px solid #555; border-radius:4px;
            background:#111; color:#eee; padding:6px;
        }
        #torn-dibs-panel button {
            margin: 8px 6px 0 0; border:1px solid #555; border-radius:4px;
            background:#2a2a2a; color:#eee; padding:5px 8px; cursor:pointer;
        }
        #torn-dibs-panel button:hover { border-color:#ff9800; }
        #torn-dibs-panel .dib-row {
            margin-top:6px; padding:6px; border:1px solid #333; border-radius:5px; background:#151515;
        }
        #torn-dibs-panel .muted { color:#888; font-size:11px; }
        #torn-dibs-panel .error { color:#ff7b7b; }
    `);

    function nowSec() {
        return Math.floor(Date.now() / 1000);
    }

    function normalizeName(value) {
        return String(value || '')
            .trim()
            .replace(/^[\s@]+|[\s:]+$/g, '')
            .toLowerCase();
    }

    // DIBS is intentionally case-insensitive: dibs / Dibs / DIBS / dIbS all count.
    function containsDibsKeyword(value) {
        return /\bdibs\b/i.test(String(value || ''));
    }

    function safeJsonParse(raw, fallback) {
        try { return JSON.parse(raw); } catch (_) { return fallback; }
    }

    function normalizeStoredState(parsed) {
        const fallback = { claims: {}, seenMessages: [] };
        if (!parsed || typeof parsed !== 'object' || !parsed.claims || typeof parsed.claims !== 'object') return fallback;
        if (!Array.isArray(parsed.seenMessages)) parsed.seenMessages = [];
        // v2.9 migration: discard the old protection/queued-clear fields completely.
        for (const claim of Object.values(parsed.claims)) {
            if (!claim || typeof claim !== 'object') continue;
            delete claim.protectedUntil;
            delete claim.pendingClear;
        }
        return parsed;
    }

    function loadState() {
        const fallback = { claims: {}, seenMessages: [] };
        try {
            const raw = localStorage.getItem(STORAGE_KEY) || '';
            lastStateRaw = raw;
            return normalizeStoredState(safeJsonParse(raw, fallback));
        } catch (_) {
            lastStateRaw = '';
            return fallback;
        }
    }

    function persistStateOnly() {
        try {
            const raw = JSON.stringify(state);
            localStorage.setItem(STORAGE_KEY, raw);
            lastStateRaw = raw;
        } catch (_) { /* ignored */ }
    }

    function mergeProcessedMessageKeysFromState() {
        const seen = Array.isArray(state?.seenMessages) ? state.seenMessages.slice(-MAX_MESSAGE_KEYS) : [];
        for (const key of seen) {
            if (!key || processedMessageKeys.has(key)) continue;
            processedMessageKeys.add(key);
            processedMessageKeyQueue.push(key);
        }
        while (processedMessageKeyQueue.length > MAX_MESSAGE_KEYS) {
            const oldest = processedMessageKeyQueue.shift();
            processedMessageKeys.delete(oldest);
        }
    }

    function syncStateFromStorage(redraw = false, suppliedRaw = null) {
        try {
            const raw = suppliedRaw === null ? (localStorage.getItem(STORAGE_KEY) || '') : String(suppliedRaw || '');
            if (raw === lastStateRaw) return false;

            const parsed = normalizeStoredState(safeJsonParse(raw, { claims: {}, seenMessages: [] }));
            state = parsed;
            lastStateRaw = raw;
            mergeProcessedMessageKeysFromState();

            if (redraw) {
                updatePill();
                renderPanel();
                applyHighlights();
            }
            return true;
        } catch (err) {
            console.warn('[Torn Dibs] state sync error:', err);
            return false;
        }
    }

    function saveState() {
        persistStateOnly();
        updatePill();
        renderPanel();
    }

    function hydrateProcessedMessageKeys() {
        const seen = Array.isArray(state?.seenMessages) ? state.seenMessages.slice(-MAX_MESSAGE_KEYS) : [];
        for (const key of seen) {
            if (!key) continue;
            processedMessageKeys.add(key);
            processedMessageKeyQueue.push(key);
        }
    }

    function getApiKey() {
        try { return String(GM_getValue(API_KEY_STORAGE, '') || '').trim(); } catch (_) { return ''; }
    }

    function setApiKey(key) {
        try { GM_setValue(API_KEY_STORAGE, String(key || '').trim()); } catch (_) { /* ignored */ }
        lastApiError = '';
        startupCatchupDone = false;
        updatePill();
    }

    function allClaims() {
        return Object.values(state.claims || {});
    }

    function claimantHasClaim(claimantKey) {
        return allClaims().some(c => c.claimantKey === claimantKey);
    }

    function findClaimByTargetId(targetId) {
        return state.claims[String(targetId)] || null;
    }

    function acceptClaim(target, claimant, messageKey, claimedAt, timestampReliable = false) {
        syncStateFromStorage(false);
        if (!target || !target.id || !claimant) return false;

        const claimantKey = normalizeName(claimant);
        if (!claimantKey) return false;

        const observedAt = nowSec();
        const eventAt = Number(claimedAt || observedAt);

        // First dibs on a target still wins. If somebody else already owns this target,
        // keep the claimant's existing dibs unchanged.
        const targetClaim = findClaimByTargetId(target.id);
        if (targetClaim) return false;

        // A claimant may only hold one target. A genuinely NEWER dibs swaps their old target.
        // Crucially, the 50-message catch-up must never replay an older historical message and
        // delete a newer claim. If Torn exposes a real message timestamp, enforce chronology.
        const previousClaim = allClaims().find(c => c.claimantKey === claimantKey);
        if (previousClaim) {
            const previousEventAt = Number(previousClaim.messageTimestamp || previousClaim.claimedAt || 0);

            if (timestampReliable && previousEventAt && eventAt < previousEventAt) {
                console.info(`[Torn Dibs] Ignored older replayed dibs from ${claimant}: ${target.name} [${target.id}]`);
                return false;
            }

            // If the message timestamp is identical, only permit a swap when it is a different
            // message key that was observed now. This still supports two fast dibs in one second.
            if (timestampReliable && previousEventAt && eventAt === previousEventAt
                && previousClaim.messageKey === messageKey) {
                return false;
            }

            delete state.claims[String(previousClaim.targetId)];
            console.info(`[Torn Dibs] ${claimant} released ${previousClaim.targetName} [${previousClaim.targetId}] to swap targets`);
        }

        const visibleFallen = getVisibleTargetFallenState(target.id);
        state.claims[String(target.id)] = {
            targetId: String(target.id),
            targetName: target.name || `Player ${target.id}`,
            claimant: claimant,
            claimantKey: claimantKey,
            // claimedAt stays tied to the chat event for attack chronology.
            claimedAt: eventAt,
            messageTimestamp: eventAt,
            messageTimestampReliable: !!timestampReliable,
            observedAt: observedAt,
            messageKey: messageKey || '',
            // If the target is already Hospital/Jail at the moment of dibs, wait for them
            // to recover before arming status-based clearing. If they are visibly Okay,
            // arm immediately. Unknown pages stay conservative until we observe a status.
            statusPhase: visibleFallen === true ? 'waiting_recovery' : visibleFallen === false ? 'armed' : 'unknown'
        };

        saveState();
        applyHighlights();
        console.info(`[Torn Dibs] ${claimant} claimed ${target.name} [${target.id}]`);
        return true;
    }

    // Automatic clears are immediate again. The previous five-minute hold was only
    // compensating for multiple script generations running at once, so there is no timer
    // and no queued clear state in this build.
    function clearClaim(targetId, reason) {
        syncStateFromStorage(false);
        const key = String(targetId);
        const claim = state.claims[key];
        if (!claim) return false;

        delete state.claims[key];
        saveState();
        applyHighlights();
        console.info(`[Torn Dibs] Cleared ${claim.targetName} [${key}]${reason ? ` — ${reason}` : ''}`);
        return true;
    }

    function clearAllClaims() {
        syncStateFromStorage(false);
        state.claims = {};
        saveState();
        applyHighlights();
    }

    function extractProfileIdFromHref(href) {
        if (!href) return null;
        const match = String(href).match(/[?&]XID=(\d+)/i);
        return match ? match[1] : null;
    }

    function cleanProfileName(text, id) {
        let name = String(text || '').trim();
        if (!name) return '';
        name = name.replace(/\s*\[\s*\d+\s*\]\s*$/, '').trim();
        if (id) name = name.replace(new RegExp(`\\s*\\[\\s*${escapeRegExp(id)}\\s*\\]\\s*$`), '').trim();
        return name;
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function scanTargets() {
        syncStateFromStorage(false);
        if (document.hidden) return;
        try {
            const links = document.querySelectorAll('a[href*="profiles.php?XID="]');
            for (const a of links) {
                if (a.closest('#chatRoot')) continue;
                const id = extractProfileIdFromHref(a.getAttribute('href'));
                if (!id) continue;
                const name = cleanProfileName(a.textContent, id);
                if (!name || name.length < 2) continue;

                const previous = targetById.get(id);
                const target = { id, name: previous?.name || name };
                targetById.set(id, target);
                targetIdByName.set(normalizeName(name), id);
            }
            applyHighlights();
        } catch (err) {
            console.warn('[Torn Dibs] target scan error:', err);
        }
    }

    function removeOwnBadges() {
        document.querySelectorAll('.torn-dibs-badge').forEach(el => el.remove());
        document.querySelectorAll('.torn-dibs-target').forEach(el => {
            el.classList.remove('torn-dibs-target');
            el.removeAttribute('data-torn-dibs');
            el.removeAttribute('title');
        });
        document.querySelectorAll('.torn-dibs-faction-list-target').forEach(el => {
            el.classList.remove('torn-dibs-faction-list-target');
            el.removeAttribute('data-dibs-list-label');
        });
        document.querySelectorAll('.torn-dibs-faction-list-row').forEach(el => {
            el.classList.remove('torn-dibs-faction-list-row');
        });
        document.querySelectorAll('.torn-dibs-profile-heading').forEach(el => {
            el.classList.remove('torn-dibs-profile-heading');
            if (el.getAttribute('data-torn-dibs-profile-title') === '1') {
                el.removeAttribute('title');
                el.removeAttribute('data-torn-dibs-profile-title');
            }
        });
    }

    function isUserProfilePage() {
        return /(?:^|\/)profiles\.php$/i.test(location.pathname) && !!new URLSearchParams(location.search).get('XID');
    }

    function getCurrentProfileId() {
        if (!isUserProfilePage()) return '';
        return String(new URLSearchParams(location.search).get('XID') || '').trim();
    }

    function findCurrentProfileHeading(targetId) {
        if (!targetId) return null;
        const needle = `[${targetId}]`;
        const candidates = document.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"],[class*="header"]'
        );

        let best = null;
        let bestScore = Infinity;
        for (const el of candidates) {
            if (!(el instanceof HTMLElement) || el.closest('#chatRoot')) continue;
            const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text.includes(needle) || text.length > 180) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 10 || rect.height > 100) continue;

            // Prefer a real heading and the smallest element containing "name [ID]".
            const headingBonus = /^H[1-6]$/.test(el.tagName) ? -100 : 0;
            const score = text.length + headingBonus;
            if (score < bestScore) {
                best = el;
                bestScore = score;
            }
        }
        return best;
    }

    function applyCurrentProfileHeaderHighlight() {
        const targetId = getCurrentProfileId();
        if (!targetId) return;
        const claim = state.claims[String(targetId)];
        if (!claim) return;

        const heading = findCurrentProfileHeading(targetId);
        if (!heading) return;

        heading.classList.add('torn-dibs-profile-heading');
        heading.setAttribute('title', `DIBS by ${claim.claimant}`);
        heading.setAttribute('data-torn-dibs-profile-title', '1');

        const badge = document.createElement('span');
        badge.className = 'torn-dibs-badge torn-dibs-profile-badge';
        badge.dataset.targetId = String(targetId);
        badge.textContent = `DIBS • ${claim.claimant}`;
        heading.appendChild(badge);
    }

    function isFactionProfilePage() {
        return /(?:^|\/)factions\.php$/i.test(location.pathname) && /(?:^|&)step=profile(?:&|$)/i.test(location.search.replace(/^\?/, ''));
    }

    function findFactionMemberRow(profileLink) {
        // Torn's faction member table is virtualized and its class names can change.
        // Walk upward and choose the first row-sized ancestor containing this profile link.
        let node = profileLink?.parentElement || null;
        for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
            if (node === document.body || node === document.documentElement) break;
            const rect = node.getBoundingClientRect();
            if (rect.width < 450 || rect.height < 28 || rect.height > 110) continue;

            const profileLinks = node.querySelectorAll('a[href*="profiles.php?XID="]');
            if (profileLinks.length !== 1) continue;

            // Prefer semantic/list-row-looking containers, but the dimensions + one-profile
            // rule is enough when Torn changes its generated CSS module names.
            const tag = node.tagName;
            const cls = String(node.className || '').toLowerCase();
            if (tag === 'LI' || tag === 'TR' || /row|member|table|user/.test(cls) || rect.width > 650) {
                return node;
            }
        }
        return null;
    }


    function compactText(el) {
        return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function elementLooksFallen(el) {
        const text = compactText(el);
        if (!text) return false;
        // Torn's member list uses explicit status labels such as "Hospital" / "Jail".
        // On profiles the status panel reads "In hospital for ...".
        return /(?:^|\s)(?:Hospital|Hospitalized|Jail|Jailed)(?:\s|$)/i.test(text)
            || /\bIn hospital for\b/i.test(text)
            || /\bIn jail for\b/i.test(text);
    }

    function findVisibleTargetRow(targetId) {
        const selector = `a[href*="profiles.php?XID=${CSS.escape(String(targetId))}"]`;
        for (const link of document.querySelectorAll(selector)) {
            if (link.closest('#chatRoot')) continue;
            const row = findFactionMemberRow(link);
            if (row) return row;
        }
        return null;
    }

    // Returns true when Torn explicitly shows Hospital/Jail, false when it explicitly
    // shows Okay, and null when this page does not currently expose a reliable status.
    // The distinction matters: a target may ALREADY be hospitalized when somebody calls
    // dibs. In that case the claim must not be deleted just because the status is red.
    function getVisibleTargetFallenState(targetId) {
        if (!targetId) return null;

        const row = findVisibleTargetRow(targetId);
        if (row) {
            const text = compactText(row);
            if (elementLooksFallen(row)) return true;
            if (/(?:^|\s)Okay(?:\s|$)/i.test(text)) return false;
        }

        if (getCurrentProfileId() === String(targetId)) {
            const candidates = document.querySelectorAll(
                '[class*="status"], [class*="hospital"], [class*="info"], [class*="userStatus"], [class*="user-status"]'
            );
            for (const el of candidates) {
                const text = compactText(el);
                if (!text || text.length > 240) continue;
                if (elementLooksFallen(el)) return true;
                if (/(?:^|\s)Okay(?:\s|$)/i.test(text)) return false;
            }
        }
        return null;
    }

    function setClaimStatusPhase(targetId, phase) {
        syncStateFromStorage(false);
        const claim = state.claims[String(targetId)];
        if (!claim || claim.statusPhase === phase) return false;
        claim.statusPhase = phase;
        persistStateOnly();
        return true;
    }

    // Status is used as a transition detector, not as an absolute delete signal.
    //   unknown + Hospital -> wait for recovery (target may have been down before dibs)
    //   unknown + Okay     -> armed
    //   waiting + Okay     -> armed
    //   armed + Hospital   -> clear (this is a NEW fall after the dibs)
    // Attack-log checks remain authoritative. Automatic clearing is immediate in v2.9.
    function observeClaimFallenState(targetId, fallen, source) {
        if (fallen === null || fallen === undefined) return false;
        syncStateFromStorage(false);
        const claim = state.claims[String(targetId)];
        if (!claim) return false;

        const phase = claim.statusPhase || 'unknown';
        if (phase === 'unknown') {
            setClaimStatusPhase(targetId, fallen ? 'waiting_recovery' : 'armed');
            return false;
        }

        if (phase === 'waiting_recovery') {
            if (!fallen) setClaimStatusPhase(targetId, 'armed');
            return false;
        }

        if (phase === 'armed' && fallen) {
            return clearClaim(targetId, `${source || 'Torn status'} changed to Hospital/Jail after dibs`);
        }
        return false;
    }

    function clearFallenClaimsFromDom() {
        syncStateFromStorage(false);
        let cleared = 0;
        for (const claim of allClaims()) {
            const fallen = getVisibleTargetFallenState(claim.targetId);
            if (observeClaimFallenState(claim.targetId, fallen, 'visible Torn status')) cleared++;
        }
        return cleared;
    }

    function applyFactionMemberListHighlight(profileLink, claim) {
        if (!isFactionProfilePage() || !profileLink || !claim) return;

        // The actual clickable name/rank banner is the most reliable visible surface in
        // Torn's list, so the label is rendered as a pseudo-element on that anchor.
        profileLink.classList.add('torn-dibs-faction-list-target');
        profileLink.setAttribute('data-dibs-list-label', `DIBS • ${claim.claimant}`);

        const row = findFactionMemberRow(profileLink);
        if (row) row.classList.add('torn-dibs-faction-list-row');
    }

    function applyHighlights() {
        try {
            removeOwnBadges();
            const claims = allClaims();
            if (!claims.length) return;

            // On the target's own profile page the heading is plain text, not a profile link.
            applyCurrentProfileHeaderHighlight();

            const links = document.querySelectorAll('a[href*="profiles.php?XID="]');
            for (const a of links) {
                if (a.closest('#chatRoot')) continue;
                const id = extractProfileIdFromHref(a.getAttribute('href'));
                if (!id) continue;
                const claim = state.claims[String(id)];
                if (!claim) continue;

                a.classList.add('torn-dibs-target');
                a.dataset.tornDibs = claim.claimant;
                a.title = `DIBS by ${claim.claimant}`;

                if (!a.parentElement?.querySelector(`.torn-dibs-badge[data-target-id="${CSS.escape(String(id))}"]`)) {
                    const badge = document.createElement('span');
                    badge.className = 'torn-dibs-badge';
                    badge.dataset.targetId = String(id);
                    badge.textContent = `DIBS • ${claim.claimant}`;
                    a.insertAdjacentElement('afterend', badge);
                }

                applyFactionMemberListHighlight(a, claim);
            }
        } catch (err) {
            console.warn('[Torn Dibs] highlight error:', err);
        }
    }

    function getFactionChatBox() {
        // Current Torn faction chat IDs use faction-* / #faction beneath #chatRoot.
        return document.querySelector('#chatRoot [id^="faction-"], #chatRoot #faction, #faction');
    }

    function findMessageList(chatBox) {
        if (!chatBox) return null;
        return chatBox.querySelector('[class*="scrollWrapper__"]') || chatBox;
    }

    function findMessageItems(root) {
        if (!root) return [];
        const out = new Set();

        // Torn currently uses virtualized message wrappers. Keep these fast paths first.
        root.querySelectorAll('[class*="virtualItem__"], [class*="virtualItem"], [class*="messageRow"], [class*="message-row"]')
            .forEach(el => out.add(el));

        root.querySelectorAll('[class*="box__"], [class*="message__"], [class*="messageItem"], li')
            .forEach(el => {
                const text = compactText(el);
                if (containsDibsKeyword(text) && text.length <= 700) out.add(el);
            });

        // Class names on Torn are generated and can change. As a fallback, locate text
        // nodes containing "dibs" and walk up only inside the faction chat until we find
        // a compact single-message container. This is intentionally scoped to chatRoot.
        try {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            let inspected = 0;
            while ((node = walker.nextNode()) && inspected++ < 3000) {
                if (!containsDibsKeyword(node.nodeValue)) continue;
                let el = node.parentElement;
                let best = null;
                for (let depth = 0; el && depth < 8 && root.contains(el); depth++, el = el.parentElement) {
                    const text = compactText(el);
                    if (!text || text.length > 700) break;
                    const dibCount = (text.match(/\bdibs\b/ig) || []).length;
                    if (dibCount > 2) break; // parent has multiple chat messages
                    const senderHint = /^[A-Za-z0-9_-]{2,32}\s*:/i.test(text)
                        || !!el.querySelector('[class*="sender"], a[href*="profiles.php"]');
                    const targetHint = /\[\s*\d{1,10}\s*\]/.test(text)
                        || Array.from(targetIdByName.keys()).some(n => text.toLowerCase().includes(n));
                    if (senderHint && targetHint) best = el;
                }
                if (best) out.add(best);
            }
        } catch (_) { /* fallback only */ }

        return Array.from(out);
    }

    function findSenderElement(msgEl) {
        return msgEl.querySelector('[class*="senderContainer__"]') || msgEl.querySelector('a[href*="profiles.php"]');
    }

    function findBodyElement(msgEl) {
        return msgEl.querySelector('[class*="body__"]')
            || msgEl.querySelector('[class*="message__"]')
            || msgEl.querySelector('[class*="content__"]');
    }

    function getOwnPlayerName() {
        try {
            const ws = document.getElementById('websocketConnectionData');
            if (ws?.textContent) {
                const parsed = JSON.parse(ws.textContent);
                if (parsed?.playername) return parsed.playername;
            }
        } catch (_) { /* ignored */ }
        return '';
    }

    function extractSender(msgEl, targetId = '') {
        const fullText = compactText(msgEl);
        const lead = fullText.match(/^([A-Za-z0-9_-]{2,32})\s*:/);
        if (lead) return lead[1];

        const senderEl = findSenderElement(msgEl);
        if (senderEl) {
            const raw = compactText(senderEl).replace(/[:\s]+$/, '');
            const token = raw.match(/[A-Za-z0-9_-]{2,32}/);
            if (token && !/^newmessage$/i.test(token[0]) && !/^you$/i.test(token[0])) return token[0];
        }

        // If Torn changed the sender class, the sender profile link is normally the first
        // profile link in the message. Exclude the target itself when the target is linked.
        const links = msgEl.querySelectorAll('a[href*="profiles.php"]');
        for (const link of links) {
            const id = extractProfileIdFromHref(link.getAttribute('href'));
            if (targetId && id && String(id) === String(targetId)) continue;
            const name = cleanProfileName(link.textContent, id);
            if (name) return name;
        }

        return getOwnPlayerName();
    }

    function getReactMessageIdentity(msgEl) {
        // Read-only inspection; no React mutation. This helps dedupe virtualized chat history.
        try {
            const elements = [msgEl, ...msgEl.querySelectorAll('*')].slice(0, 30);
            for (const el of elements) {
                const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
                if (!fiberKey) continue;
                let fiber = el[fiberKey];
                for (let i = 0; i < 5 && fiber; i++, fiber = fiber.return) {
                    const props = fiber.memoizedProps || fiber.pendingProps;
                    const msg = props?.message;
                    if (msg && typeof msg === 'object') {
                        const id = msg.id ?? msg.messageId ?? msg.message_id ?? msg.uuid;
                        if (id != null) return `id:${id}`;
                        const ts = msg.time ?? msg.timestamp ?? msg.createdAt ?? msg.created_at;
                        if (ts != null) return `ts:${ts}`;
                    }
                    const directId = props?.messageId ?? props?.message_id;
                    if (directId != null) return `id:${directId}`;
                    const directTs = props?.time ?? props?.timestamp;
                    if (typeof directTs === 'number' && directTs > 1e9) return `ts:${directTs}`;
                }
            }
        } catch (_) { /* ignored */ }
        return '';
    }

    function extractMessageTimestampInfo(msgEl) {
        try {
            const elements = [msgEl, ...msgEl.querySelectorAll('*')].slice(0, 30);
            for (const el of elements) {
                const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
                if (!fiberKey) continue;
                let fiber = el[fiberKey];
                for (let i = 0; i < 5 && fiber; i++, fiber = fiber.return) {
                    const props = fiber.memoizedProps || fiber.pendingProps;
                    const msg = props?.message;
                    const raw = msg?.time ?? msg?.timestamp ?? msg?.createdAt ?? msg?.created_at
                        ?? props?.time ?? props?.timestamp;
                    if (typeof raw === 'number' && raw > 1e9) {
                        return { sec: Math.floor(raw > 1e12 ? raw / 1000 : raw), reliable: true };
                    }
                }
            }
        } catch (_) { /* ignored */ }

        try {
            const timeEl = msgEl.querySelector('time[datetime]');
            if (timeEl) {
                const ms = Date.parse(timeEl.getAttribute('datetime'));
                if (Number.isFinite(ms)) return { sec: Math.floor(ms / 1000), reliable: true };
            }
        } catch (_) { /* ignored */ }
        return { sec: nowSec(), reliable: false };
    }

    function extractMessageTimestampSec(msgEl) {
        return extractMessageTimestampInfo(msgEl).sec;
    }

    function getDomTimeHint(msgEl) {
        const candidates = msgEl.querySelectorAll('time, [title], [class*="time__"], [class*="timestamp__"]');
        for (const el of candidates) {
            const v = `${el.getAttribute?.('datetime') || ''}|${el.getAttribute?.('title') || ''}|${el.textContent || ''}`.trim();
            if (v && /\d/.test(v)) return v.slice(0, 80);
        }
        return '';
    }

    function buildMessageKey(msgEl, sender, bodyText) {
        const reactId = getReactMessageIdentity(msgEl);
        if (reactId) return `${reactId}|${normalizeName(sender)}|${bodyText}`;
        const timeHint = getDomTimeHint(msgEl);
        return `${normalizeName(sender)}|${timeHint}|${bodyText}`;
    }

    function rememberMessageKey(key) {
        syncStateFromStorage(false);
        if (!key || processedMessageKeys.has(key)) return false;
        processedMessageKeys.add(key);
        processedMessageKeyQueue.push(key);
        while (processedMessageKeyQueue.length > MAX_MESSAGE_KEYS) {
            const oldest = processedMessageKeyQueue.shift();
            processedMessageKeys.delete(oldest);
        }
        if (!Array.isArray(state.seenMessages)) state.seenMessages = [];
        state.seenMessages.push(key);
        if (state.seenMessages.length > MAX_MESSAGE_KEYS) state.seenMessages = state.seenMessages.slice(-MAX_MESSAGE_KEYS);
        persistStateOnly();
        return true;
    }

    function findTargetInMessage(bodyEl, bodyText) {
        // Strongest signal: Name [123456]. Choose the bracketed ID closest to the word
        // "dibs". This avoids mistaking the sender's profile link for the target when
        // Torn renders the entire message wrapper instead of just the body.
        const idMatches = Array.from(bodyText.matchAll(/\[(\d{1,10})\]/g));
        if (idMatches.length) {
            const dibPositions = Array.from(bodyText.matchAll(/\bdibs\b/ig)).map(m => m.index ?? 0);
            const dibPos = dibPositions.length ? dibPositions[dibPositions.length - 1] : bodyText.length;
            const idMatch = idMatches.reduce((best, cur) =>
                Math.abs((cur.index ?? 0) - dibPos) < Math.abs((best.index ?? 0) - dibPos) ? cur : best
            );
            const id = idMatch[1];
            const cached = targetById.get(id);
            let name = cached?.name || '';
            if (!name) {
                let before = bodyText.slice(0, idMatch.index).replace(/\bdibs\b/ig, ' ').trim();
                before = before.replace(/^[A-Za-z0-9_-]{2,32}\s*:\s*/, '');
                const token = before.split(/\s+/).filter(Boolean).pop();
                if (token) name = token.replace(/[,:;()\[\]]+$/g, '');
            }
            return { id, name: name || `Player ${id}` };
        }

        // If there is no bracketed ID, a linked profile is the next best signal. Prefer
        // the link whose visible text is closest to the word "dibs".
        const links = Array.from(bodyEl?.querySelectorAll?.('a[href*="profiles.php?XID="]') || []);
        if (links.length) {
            const dibPos = bodyText.toLowerCase().lastIndexOf('dibs');
            let best = null;
            let bestScore = Infinity;
            for (const link of links) {
                const id = extractProfileIdFromHref(link.getAttribute('href'));
                if (!id) continue;
                const linkText = compactText(link);
                const pos = linkText ? bodyText.toLowerCase().lastIndexOf(linkText.toLowerCase()) : -1;
                const score = pos >= 0 && dibPos >= 0 ? Math.abs(dibPos - pos) : 9999;
                if (score < bestScore) { best = { link, id }; bestScore = score; }
            }
            if (best) {
                const cached = targetById.get(best.id);
                return { id: best.id, name: cached?.name || cleanProfileName(best.link.textContent, best.id) || `Player ${best.id}` };
            }
        }

        // Bare numeric ID is accepted only if it is already known from a Torn profile link.
        for (const match of bodyText.matchAll(/\b(\d{1,10})\b/g)) {
            const id = match[1];
            const cached = targetById.get(id);
            if (cached) return { id, name: cached.name || `Player ${id}` };
        }

        // Plain-name mode. Accept exact known Torn names from profile links on the page.
        const names = Array.from(targetIdByName.keys()).sort((a, b) => b.length - a.length);
        const lcText = bodyText.toLowerCase();
        for (const lcName of names) {
            const pattern = new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(lcName)}([^a-z0-9_-]|$)`, 'i');
            if (!pattern.test(lcText)) continue;
            const id = targetIdByName.get(lcName);
            const cached = targetById.get(String(id));
            if (id) return { id: String(id), name: cached?.name || lcName };
        }
        return null;
    }

    function processMessage(msgEl) {
        try {
            const bodyEl = findBodyElement(msgEl) || msgEl;
            const bodyText = compactText(bodyEl);
            if (!containsDibsKeyword(bodyText)) return;

            const target = findTargetInMessage(bodyEl, bodyText);
            if (!target) return;

            const sender = extractSender(msgEl, target.id);
            if (!sender) return;

            const messageKey = buildMessageKey(msgEl, sender, bodyText);
            if (processedMessageKeys.has(messageKey)) return;
            if (!rememberMessageKey(messageKey)) return;

            if (target.id && target.name) {
                targetById.set(String(target.id), { id: String(target.id), name: target.name });
                targetIdByName.set(normalizeName(target.name), String(target.id));
            }

            const timestampInfo = extractMessageTimestampInfo(msgEl);
            acceptClaim(target, sender, messageKey, timestampInfo.sec, timestampInfo.reliable);
        } catch (err) {
            console.warn('[Torn Dibs] message parse error:', err);
        }
    }


    function queueChatScan() {
        if (chatScanQueued) return;
        chatScanQueued = true;
        setTimeout(() => {
            chatScanQueued = false;
            scanFactionChat();
        }, 80);
    }

    function ensureChatObserver() {