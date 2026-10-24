/**
 * Legacy compatibility module.
 * The active gate, finance, audit and backup panels are implemented in App.jsx
 * and FinancialLedgerPanel.jsx. This file intentionally exports a harmless
 * placeholder because this older duplicate panel is no longer imported.
 */
export default function AdminOperations() {
  return null;
}
