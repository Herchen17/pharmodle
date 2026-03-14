const r = JSON.parse(require('fs').readFileSync('data/reviews.json','utf8'));
const p = JSON.parse(require('fs').readFileSync('data/.review_progress.json','utf8'));
const completed = Object.values(r).filter(x => !x.error).length;
const errors = Object.values(r).filter(x => x.error).length;
const poor = Object.values(r).filter(x => x.overall_quality === 'poor').length;

console.log('Progress: ' + (p.lastIndex + 1) + ' / 775');
console.log('Completed: ' + completed + ' | Errors: ' + errors + ' | Poor: ' + poor);
console.log('');
console.log('POOR puzzles:');
Object.values(r).filter(x => x.overall_quality === 'poor').forEach(x => {
  console.log('  - ' + x.answer + ' (' + x.category + ')');
});
