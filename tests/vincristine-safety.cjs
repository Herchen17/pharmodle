const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
const pm = require(root + '/puzzle-manager');
pm.loadPuzzles();
const p = pm.fullPuzzle(pm.getPuzzleForDay(4));
assert.equal(p.answer, 'Vincristine');
for (const [name,text] of [['final clue', p.clues[4].text], ['explanation',p.explanation],['near miss',p.near_misses.feedback],['walkthrough',p.walkthrough]]) {
 assert.match(text, /intravenous|IV/i, name + ' must specify IV');
 assert.match(text, /intrathecal administration is (?:absolutely )?contraindicated/i, name + ' must prohibit intrathecal use');
 assert.match(text, /fatal|death/i, name + ' must state fatal risk');
 assert.doesNotMatch(text, /accepted intrathecal|routinely administered intrathecally|only vinca alkaloid used intrathecally|safe for direct cerebrospinal|unique role in intrathecal/i, name + ' unsafe claim');
}
console.log('PASS: all four served vincristine fields specify IV only and prohibit fatal intrathecal administration');
