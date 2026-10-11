/*
 * Settings for the web pages.
 *
 * apiUrl: leave empty for DEMO MODE (everything runs in this browser with fake data and a
 *         fake outbox). For live use, paste the Apps Script web app URL (ends in /exec).
 * captureIp: record the signer's public IP address in the audit trail. The browser asks
 *         api.ipify.org for it, so it is "reported by the device", not proven.
 */
window.ESIGN_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbzuUpn3Y-TKBQnY6k1skyjvyazPASZV0WqofpAaVd52_sAQoKbjsIE_6K1kpRoDI61q/exec',
  captureIp: true,
  appName: 'Tenancy e-sign',
  ownerName: 'Sam Owner'
};
