const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '../static/js/botsSectionWatch.js')).href);
  assert.equal(model.stateLabel('working'), 'Watching your day');
  assert.equal(model.stateLabel('paused'), 'Paused');
  assert.equal(model.stateLabel('off'), 'Off');
  assert.equal(model.stateLabel('not_connected'), 'Connect mail or calendar');
  assert.equal(model.validMorningTime('08:00'), true);
  for (const value of ['8:00', '24:00', '12:60', '', '08:00\n']) assert.equal(model.validMorningTime(value), false, value);
  assert.match(model.showMeOutcome(null), /Checking/);
  assert.equal(model.showMeOutcome('NOTHING NEW'), 'Nothing new right now. I will keep checking.');
  assert.equal(model.showMeOutcome(null, 180000), 'Nothing new right now. I will keep checking.');
  assert.equal(model.showMeOutcome('error'), 'Could not check just now. Try again.');
  assert.equal(model.showMeOutcome('Updated your brief'), 'Your brief is up to date.');
  console.log('PASS: watch states, outcomes and morning time validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
