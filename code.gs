// ============================================================
// AKINO SOLAR — COMMAND CENTER API (WORLD AKINO)
// Bound to: WORLD AKINO spreadsheet (ID below)
// Deploy as: Web App
//   Execute as: User accessing the web app
//   Who has access: Anyone within akinosolar.com
// Runtime: V8 (confirm under Project Settings > General > Runtime)
// Notes:
// - FAIL-CLOSED auth: no email => Unauthorized
// - Reads ONLY WORLD AKINO
// - Does NOT rebuild routing/true-cost logic (reads DASHBOARD_* views)
// - Dashboard calls server via google.script.run (zero-CORS)
// ============================================================

const WORLD_AKINO_ID = '10KNqacZeBTMAv4W6lNb2EeKAgVTdPNNPuzhCum4BKXY';
const ALLOWED_DOMAIN = 'akinosolar.com';

// ============================================================
// WEB APP ENTRY POINTS
// ============================================================

/**
 * GET handler — serves dashboard HTML (no action param) or JSON API.
 * The dashboard itself uses google.script.run via apiCall() below,
 * so the ?action= JSON path is only needed for external/direct calls.
 */
function doGet(e) {
  const email = safeGetEmail_();
  if (!isAllowedEmail_(email)) {
    // If no action param, show unauthorized HTML; otherwise JSON
    if (!e || !e.parameter || !e.parameter.action) {
      return HtmlService.createHtmlOutput('<h2>Unauthorized</h2><p>Sign in with an @akinosolar.com account.</p>');
    }
    return jsonOut_({ ok: false, error: 'Unauthorized' });
  }

  // Optional role gating via DASHBOARD_USERS tab.
  // Tab MISSING => fail open (allow all @akinosolar.com, default role=admin).
  // Tab EXISTS but user not in it or active!=TRUE => fail closed.
  const userRecord = safeLookupUser_(email);
  if (userRecord === false) {
    if (!e || !e.parameter || !e.parameter.action) {
      return HtmlService.createHtmlOutput('<h2>Account Inactive</h2><p>Contact your admin.</p>');
    }
    return jsonOut_({ ok: false, error: 'Account inactive' });
  }

  const role = (userRecord && userRecord.role) ? String(userRecord.role) : 'admin';

  // No action parameter => serve the dashboard HTML
  if (!e || !e.parameter || !e.parameter.action) {
    return HtmlService.createHtmlOutputFromFile('dashboard')
      .setTitle('Akino Solar — Command Center')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // JSON API path (for external callers / direct URL hits)
  const action = String(e.parameter.action);
  return jsonOut_(executeAction_(action, e.parameter, role, email));
}

/**
 * POST handler — controlled writes (e.g. addClaim).
 */
function doPost(e) {
  const email = safeGetEmail_();
  if (!isAllowedEmail_(email)) {
    return jsonOut_({ ok: false, error: 'Unauthorized' });
  }

  const userRecord = safeLookupUser_(email);
  const role = (userRecord && userRecord.role) ? String(userRecord.role) : 'admin';
  if (role !== 'owner' && role !== 'manager' && role !== 'admin') {
    return jsonOut_({ ok: false, error: 'Forbidden' });
  }

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
    if (body.action !== 'addClaim') {
      return jsonOut_({ ok: false, error: 'Unknown post action' });
    }

    const ss = SpreadsheetApp.openById(WORLD_AKINO_ID);
    const sheet = ss.getSheetByName('DASHBOARD_CLAIMS');
    if (!sheet) throw new Error('Tab not found: DASHBOARD_CLAIMS');

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    const payload = body.data || {};
    const row = headers.map(h => {
      if (h === 'submittedDate') return new Date();
      return (payload[h] !== undefined && payload[h] !== null) ? payload[h] : '';
    });
    sheet.appendRow(row);
    return jsonOut_({ ok: true, data: { appended: true } });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// google.script.run BRIDGE (called from dashboard JS)
// ============================================================
// The dashboard's fetch() calls are intercepted client-side and
// routed here via google.script.run.apiCall(action, params).
// This avoids CORS/auth-redirect issues that happen when
// HtmlService pages make fetch() calls to the GAS web-app URL.
// ============================================================

/**
 * Bridge function for google.script.run calls from the dashboard.
 * Returns a plain object (not ContentService TextOutput).
 *
 * @param {string} action - The API action (health, kpis, jobs, etc.)
 * @param {Object} params - Additional parameters (range, limit, etc.)
 * @return {Object} API response object { ok, data/error }
 */
function apiCall(action, params) {
  const email = safeGetEmail_();
  if (!isAllowedEmail_(email)) {
    return { ok: false, error: 'Unauthorized' };
  }

  const userRecord = safeLookupUser_(email);
  if (userRecord === false) {
    return { ok: false, error: 'Account inactive' };
  }

  const role = (userRecord && userRecord.role) ? String(userRecord.role) : 'admin';
  return executeAction_(action, params || {}, role, email);
}

/**
 * Bridge for POST-type actions from the dashboard.
 *
 * @param {string} action - The post action (addClaim, etc.)
 * @param {Object} data   - Payload data
 * @return {Object} API response object
 */
function postApiCall(action, data) {
  const email = safeGetEmail_();
  if (!isAllowedEmail_(email)) {
    return { ok: false, error: 'Unauthorized' };
  }

  const userRecord = safeLookupUser_(email);
  const role = (userRecord && userRecord.role) ? String(userRecord.role) : 'admin';
  if (role !== 'owner' && role !== 'manager' && role !== 'admin') {
    return { ok: false, error: 'Forbidden' };
  }

  try {
    if (action !== 'addClaim') {
      return { ok: false, error: 'Unknown post action' };
    }

    const ss = SpreadsheetApp.openById(WORLD_AKINO_ID);
    const sheet = ss.getSheetByName('DASHBOARD_CLAIMS');
    if (!sheet) throw new Error('Tab not found: DASHBOARD_CLAIMS');

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    const payload = data || {};
    const row = headers.map(h => {
      if (h === 'submittedDate') return new Date();
      return (payload[h] !== undefined && payload[h] !== null) ? payload[h] : '';
    });
    sheet.appendRow(row);
    return { ok: true, data: { appended: true } };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// ============================================================
// SHARED ACTION ROUTER
// ============================================================

function executeAction_(action, params, role, email) {
  try {
    switch (action) {
      case 'health':
        return { ok: true, data: { status: 'ok', timestamp: new Date().toISOString(), user: email, role: role } };

      case 'kpis':
        return { ok: true, data: readKeyValueTab_('DASHBOARD_KPIS') };

      case 'jobs': {
        const range = (params && params.range) ? String(params.range).toLowerCase() : 'all';
        const tab = range === 'today' ? 'DASHBOARD_JOBS_TODAY' : 'DASHBOARD_JOBS_ALL';
        return { ok: true, data: readTable_(tab) };
      }

      case 'team':
        return { ok: true, data: readTable_('DASHBOARD_TEAM') };

      case 'expenses':
        return { ok: true, data: readTable_('DASHBOARD_EXPENSES') };

      case 'activity': {
        const limit = Math.max(1, Math.min(200, parseInt((params && params.limit) ? params.limit : '20', 10)));
        const rows = readTable_('DASHBOARD_ACTIVITY');
        return { ok: true, data: rows.slice(0, limit) };
      }

      case 'claims':
        return { ok: true, data: readTable_('DASHBOARD_CLAIMS') };

      case 'routes':
        return { ok: true, data: readTable_('DASHBOARD_ROUTES') };

      case 'solarcare':
        return { ok: true, data: readTable_('DASHBOARD_SOLARCARE') };

      case 'users':
        if (role !== 'owner' && role !== 'manager') {
          return { ok: false, error: 'Forbidden' };
        }
        return { ok: true, data: readTable_('DASHBOARD_USERS') };

      default:
        return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// ============================================================
// HELPERS
// ============================================================

function safeGetEmail_() {
  try {
    const email = Session.getActiveUser().getEmail();
    return email ? String(email).trim() : '';
  } catch (e) {
    return '';
  }
}

function isAllowedEmail_(email) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  return e.endsWith('@' + ALLOWED_DOMAIN);
}

function readTable_(tabName) {
  const ss = SpreadsheetApp.openById(WORLD_AKINO_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1)
    .filter(r => r.some(c => c !== '' && c !== null))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        let v = r[i];
        if (v instanceof Date) v = v.toISOString();
        obj[h] = v;
      });
      return obj;
    });
}

function readKeyValueTab_(tabName) {
  const ss = SpreadsheetApp.openById(WORLD_AKINO_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const values = sheet.getDataRange().getValues();
  const out = {};
  values.forEach(r => {
    if (!r[0]) return;
    const k = String(r[0]).trim();
    let v = r[1];
    if (v instanceof Date) v = v.toISOString();
    if (v !== '' && v !== null && !isNaN(v)) v = Number(v);
    out[k] = v;
  });
  return out;
}

/**
 * Lookup user in DASHBOARD_USERS tab.
 * Returns:
 *   null  - tab does not exist (fail open: allow all @akinosolar.com)
 *   false - tab exists but user not found or active != TRUE (fail closed)
 *   obj   - user record with role + active (allow)
 */
function safeLookupUser_(email) {
  try {
    const rows = readTable_('DASHBOARD_USERS');
    const found = rows.find(r => String(r.email || '').trim().toLowerCase() === String(email).toLowerCase());
    if (!found) return false;
    const active = String(found.active || '').toUpperCase();
    if (active !== 'TRUE' && active !== '1') return false;
    return found;
  } catch (e) {
    // Tab doesn't exist => fail open
    return null;
  }
}

function jsonOut_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
