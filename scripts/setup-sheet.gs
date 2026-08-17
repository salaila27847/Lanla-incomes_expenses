/**
 * One-time setup for the Smart Expense & Price Tracker's Google Sheet.
 *
 * Creates any of the nine tabs the controller expects that don't exist yet,
 * with the exact header row and column formats it reads back.
 *
 * How to run it:
 *   1. Open the Google Sheet.
 *   2. Extensions -> Apps Script.
 *   3. Replace whatever is in the editor with this file, then Save.
 *   4. Run -> setUpTrackerSheet, and approve the permission prompt.
 *   5. Read the summary it logs (View -> Logs), then close the editor.
 *
 * Safe to run more than once: a tab that already exists is left completely
 * alone -- no headers rewritten, no formats changed, no rows touched. Only
 * missing tabs are created, so this can't disturb data already in the Sheet.
 *
 * See SETUP.md for what each tab means.
 */

/**
 * Text-formatted columns are not cosmetic.
 *
 * The Sheets API returns formatted values, so a cell Google decided was a
 * date comes back the way it is displayed. "2026-01" would be stored as
 * January 2026 and read back as "Jan 2026"; "2026-07-25" as "25/07/2026".
 * The controller matches YYYY-MM and YYYY-MM-DD exactly and would reject
 * both. Forcing these columns to plain text keeps what is typed literal.
 */
var TABS = [
  {
    name: 'MasterItems',
    headers: ['Name', 'Category', 'CreatedAt'],
    textColumns: [],
  },
  {
    // Price is per unit and BEFORE any discount, so the price history
    // keeps what a product normally costs; Quantity multiplies it and
    // Discount comes off the line. What was paid is
    // Price * Quantity - Discount. ID is what lets a row be edited later.
    name: 'PriceHistory',
    headers: [
      'Date', 'Store', 'MasterItemName', 'Category', 'Price', 'Quantity', 'ID', 'Discount',
    ],
    textColumns: [1, 7], // Date, ID
  },
  {
    // A line paid straight from the savings account isn't a recorded
    // expense yet -- it sits here until the transfer-back QR is confirmed
    // on the SavingsQR page, at which point it moves to PriceHistory using
    // this row's own Date (not the confirmation date).
    name: 'PendingSavings',
    headers: [
      'ID', 'Date', 'Store', 'MasterItemName', 'Category', 'Price', 'Quantity', 'Discount', 'CreatedAt',
    ],
    textColumns: [1, 2, 9], // ID, Date, CreatedAt
  },
  {
    name: 'MustPay',
    // RecurringGroupKey is set only on a row generated from a
    // RecurringBills entry -- blank for anything typed in by hand.
    headers: ['ID', 'Name', 'Amount', 'Month', 'Status', 'PaidAt', 'RecurringGroupKey'],
    textColumns: [4], // Month: a pay-cycle key, YYYY-MM
  },
  {
    // A template, not a per-cycle row: the app creates one MustPay row per
    // active bill here the first time a new cycle is opened. Blank
    // InstallmentsRemaining means no end date; a number counts down and
    // the bill goes inactive at zero. Bills sharing a CardGroup collapse
    // into a single MustPay row each cycle, summing their amounts.
    name: 'RecurringBills',
    headers: ['ID', 'Name', 'Amount', 'CardGroup', 'InstallmentsRemaining', 'Active'],
    textColumns: [],
  },
  {
    name: 'Cycles',
    headers: ['CycleKey', 'PaydayDate', 'SavingsBalance'],
    textColumns: [1, 2], // CycleKey, PaydayDate
  },
  {
    // Maps a transfer slip's registered payee name to the store name the
    // app actually records -- written automatically the first time a
    // slip-scanned receipt for that payee is confirmed, and read back to
    // prefill the store field next time. Nothing to fill in by hand.
    name: 'SlipPayees',
    headers: ['PayeeName', 'StoreName'],
    textColumns: [],
  },
  {
    name: 'Income',
    headers: ['ID', 'Date', 'Source', 'Amount'],
    textColumns: [2], // Date
  },
  {
    name: 'Settings',
    headers: ['Key', 'Value'],
    textColumns: [1], // Key
  },
];

function setUpTrackerSheet() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var created = [];
  var skipped = [];

  TABS.forEach(function (tab) {
    if (spreadsheet.getSheetByName(tab.name)) {
      skipped.push(tab.name);
      return;
    }

    var sheet = spreadsheet.insertSheet(tab.name);
    sheet.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    tab.textColumns.forEach(function (column) {
      sheet.getRange(2, column, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    });

    if (tab.name === 'Cycles') seedCycles(sheet);
    if (tab.name === 'Settings') seedSettings(sheet);

    created.push(tab.name);
  });

  var summary =
    'Created: ' + (created.length ? created.join(', ') : '(none)') + '\n' +
    'Already there, left untouched: ' + (skipped.length ? skipped.join(', ') : '(none)') + '\n\n' +
    'Next: fill in the PaydayDate column on the Cycles tab with the day your\n' +
    'salary actually lands each month. Any month you leave blank is estimated\n' +
    'from the nearest one you did fill in.';

  Logger.log(summary);
  SpreadsheetApp.getUi().alert(summary);
}

/**
 * Twelve empty rows for the current year, so the payday calendar is a
 * column to fill in rather than one to build from scratch.
 *
 * A cycle is named for the month whose 15th falls inside it, so the row
 * keyed 2026-01 wants the payday that opened it -- typically late December.
 */
function seedCycles(sheet) {
  var year = new Date().getFullYear();
  var rows = [];
  for (var month = 1; month <= 12; month += 1) {
    rows.push([year + '-' + ('0' + month).slice(-2), '', '']);
  }
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  sheet.getRange('B1').setNote(
    'The date the salary actually landed, as YYYY-MM-DD.\n\n' +
    'The cycle runs from this date to the day before the next payday. A ' +
    'cycle is named for the month whose 15th it contains, so a payday of ' +
    '2025-12-26 belongs to the 2026-01 row.',
  );
  sheet.getRange('C1').setNote(
    "The savings account's closing balance for this cycle, read off your " +
    'bank. Leave blank if you have not checked -- blank means unknown, ' +
    'which is not the same as zero.',
  );
}

/**
 * Read-only health check. Run this after setUpTrackerSheet, or on a Sheet
 * that predates it, to see whether the controller will actually be able to
 * read what's there.
 *
 * setUpTrackerSheet never touches an existing tab, which is the safe
 * default but means a tab created before these formats existed can still
 * hold values the app will reject. This reports that instead of guessing.
 */
function checkTrackerSheet() {
  var PATTERNS = [
    { tab: 'PriceHistory', column: 1, label: 'Date', regex: /^\d{4}-\d{2}-\d{2}$/, want: 'YYYY-MM-DD' },
    { tab: 'MustPay', column: 4, label: 'Month', regex: /^\d{4}-\d{2}$/, want: 'YYYY-MM' },
    { tab: 'Cycles', column: 1, label: 'CycleKey', regex: /^\d{4}-\d{2}$/, want: 'YYYY-MM' },
    { tab: 'Cycles', column: 2, label: 'PaydayDate', regex: /^\d{4}-\d{2}-\d{2}$/, want: 'YYYY-MM-DD' },
    { tab: 'Income', column: 2, label: 'Date', regex: /^\d{4}-\d{2}-\d{2}$/, want: 'YYYY-MM-DD' },
    { tab: 'PendingSavings', column: 2, label: 'Date', regex: /^\d{4}-\d{2}-\d{2}$/, want: 'YYYY-MM-DD' },
  ];
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var problems = [];

  TABS.forEach(function (tab) {
    var sheet = spreadsheet.getSheetByName(tab.name);
    if (!sheet) {
      problems.push('Missing tab: ' + tab.name);
      return;
    }

    // Columns added to a tab that already existed are the blind spot:
    // setUpTrackerSheet skipped the tab entirely, so nothing added them.
    var headers = sheet.getRange(1, 1, 1, tab.headers.length).getDisplayValues()[0];
    var missing = tab.headers.filter(function (header, index) {
      return String(headers[index]).trim() !== header;
    });
    if (missing.length) {
      problems.push(
        tab.name + ' is missing or mislabelled column(s): ' + missing.join(', ') +
        '. Expected the header row to read: ' + tab.headers.join(' | '),
      );
    }
  });

  PATTERNS.forEach(function (check) {
    var sheet = spreadsheet.getSheetByName(check.tab);
    if (!sheet || sheet.getLastRow() < 2) return;

    // getDisplayValues matches what the Sheets API returns to the app --
    // reading the underlying value would hide exactly the bug we're after.
    var values = sheet.getRange(2, check.column, sheet.getLastRow() - 1, 1).getDisplayValues();
    for (var index = 0; index < values.length; index += 1) {
      var value = String(values[index][0]).trim();
      if (value === '' || check.regex.test(value)) continue;
      problems.push(
        check.tab + '!' + check.label + ' row ' + (index + 2) + ' reads as "' + value +
        '" but the app needs ' + check.want + '. Select the column, set Format -> Number -> ' +
        'Plain text, then retype the affected cells.',
      );
      break; // one example per column is enough to act on
    }
  });

  var summary = problems.length
    ? 'Found ' + problems.length + ' thing(s) to fix:\n\n- ' + problems.join('\n- ')
    : 'All nine tabs are present and every dated column reads back in the format the app expects.';

  Logger.log(summary);
  SpreadsheetApp.getUi().alert(summary);
}

/** The three settings the app reads, at their defaults, so they are visible
 *  and editable rather than invisible until someone knows the key names. */
function seedSettings(sheet) {
  sheet.getRange(2, 1, 3, 2).setValues([
    ['opening_balance', 0],
    ['cycle_budget_food', 5000],
    ['cycle_budget_goods', 5000],
  ]);
  sheet.getRange('A2').setNote('Starting balance of the spending account. The dashboard runs its balance forward from here.');
  sheet.getRange('A3').setNote('Food cap per pay cycle (not per day).');
  sheet.getRange('A4').setNote('Household-goods cap per pay cycle (not per day).');
}
