/**
 * Inventory Count — server side
 * -------------------------------------------------------------
 * Reads item lists from the lookup tabs and appends counted
 * entries to the "Metals" and "Plastics" tabs.
 *
 * Required tabs in this spreadsheet:
 *   Lookups:  Cans_Lookup | Ends_Lookup | Plastics_Lookup
 *   Output :  Metals      | Plastics
 * (Use the provided Inventory_Database.xlsx to create them.)
 */

// ---- Tab names (change here if you rename tabs) ----
var TAB = {
  ends:      'Ends_Lookup',
  cans:      'Cans_Lookup',
  plastics:  'Plastics_Lookup',
  metalsOut: 'Metals',
  plasticsOut:'Plastics'
};

// Serve the web app
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Inventory Count')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Return all three item lists to the browser.
 * Called once when the page loads.
 */
function getLookups() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ends:     readEnds(ss.getSheetByName(TAB.ends)),
    cans:     readCans(ss.getSheetByName(TAB.cans)),
    plastics: readPlastics(ss.getSheetByName(TAB.plastics))
  };
}

function rows_(sheet) {
  if (!sheet) return [];
  var lr = sheet.getLastRow();
  if (lr < 2) return [];
  return sheet.getRange(2, 1, lr - 1, sheet.getLastColumn()).getValues();
}
function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function num_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isNaN(n) ? str_(v) : n;
}

// Ends_Lookup: Label Code | Description | Per Pallet | Weight | Type
function readEnds(sheet) {
  return rows_(sheet).filter(function (r) { return str_(r[1]); }).map(function (r) {
    return { code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]), weight: str_(r[3]), type: str_(r[4]) };
  });
}
// Cans_Lookup: Label Number | Description | Per Pallet  (many have no code)
function readCans(sheet) {
  return rows_(sheet).filter(function (r) { return str_(r[1]); }).map(function (r) {
    return { code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]) };
  });
}
// Plastics_Lookup: Item # | Description | Type | Per Pallet/Box
function readPlastics(sheet) {
  return rows_(sheet).filter(function (r) { return str_(r[1]); }).map(function (r) {
    return { code: str_(r[0]), desc: str_(r[1]), type: str_(r[2]), perUnit: num_(r[3]) };
  });
}

/**
 * Append one counted entry.
 * dept = 'metals' or 'plastics'.
 * A lock keeps two counters from writing the same row at once.
 */
function appendEntry(e, dept) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // wait up to 20s for the other person's write to finish
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var row;
    var sheet;
    if (dept === 'plastics') {
      sheet = ss.getSheetByName(TAB.plasticsOut);
      // Timestamp | Counter | Item # | Description | Type | Per Unit | Full | Extra | Total | Location
      row = [e.ts, e.counter, e.code, e.desc, e.type, e.per, e.full, e.extra, e.total, e.loc];
    } else {
      sheet = ss.getSheetByName(TAB.metalsOut);
      // Timestamp | Counter | Category | Code | Description | Weight | Type | Per Unit | Full | Extra | Total | Location
      row = [e.ts, e.counter, e.category, e.code, e.desc, e.weight, e.type, e.per, e.full, e.extra, e.total, e.loc];
    }
    if (!sheet) throw new Error('Output tab not found for ' + dept);
    sheet.appendRow(row);
    SpreadsheetApp.flush();
    return true;
  } finally {
    lock.releaseLock();
  }
}
