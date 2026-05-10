'use strict';

// Small blocklist to catch obvious names. Not exhaustive — host can kick too.
const BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'b1tch', 'bich', 'cunt', 'asshole', 'dick', 'pussy', 'cock',
  'nigger', 'nigga', 'faggot', 'retard', 'slut', 'whore', 'hoe', 'ho', 'bastard',
  'fck', 'sh1t', 'b1tch', 'a55hole', 'fuk', 'phuck', 'ass', 'sht', 'motherfucker'
];

function isBlocked(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!n) return false;
  return BLOCKLIST.some((bad) => n.includes(bad));
}

module.exports = { isBlocked };
