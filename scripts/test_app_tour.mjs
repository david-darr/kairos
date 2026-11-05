// The Kairos tour's plan and text (static/js/appTour.js). No DOM.
// Run: node scripts/test_app_tour.mjs
import assert from 'node:assert/strict';
import { STOPS, planStops, tourText } from '../static/js/appTour.js';

const ids = stops => stops.map(stop => stop.id);

// Everyone gets the Kairos tabs; Forge, Bots and the mode switch are an admin's.
const person = planStops(STOPS);
assert.deepEqual(ids(person), ['around', 'home', 'chat', 'notes', 'library', 'calendar', 'email', 'tasks', 'store', 'cookbook', 'settings']);
assert.ok(!person[0].steps.some(step => step.title === 'Three modes'), 'no mode switch for a non-admin');
const admin = planStops(STOPS, { admin: true });
assert.deepEqual(ids(admin).slice(-2), ['forge', 'bots']);
assert.equal(admin[0].steps[0].title, 'Three modes');

// Tabs added from the Tool Store get their own stop, one step each, with a known note where there is one.
const added = planStops(STOPS, { added: [{ tab: 'tab:studio', label: 'Studio' }, { tab: 'tab:widgets', label: 'Widgets' }] });
const stop = added.find(s => s.id === 'added');
assert.deepEqual(stop.steps.map(s => s.title), ['Studio', 'Widgets']);
assert.match(stop.steps[0].text, /Make videos/);
assert.match(stop.steps[1].text, /A tab you added from the Tool Store/);
assert.equal(stop.steps[0].anchor, '#sidebar .nav-item[data-tab="tab:studio"]');
assert.ok(ids(added).indexOf('added') < ids(added).indexOf('settings'));

// Every step says something, in short plain sentences, with no dashes as punctuation.
for (const s of planStops(STOPS, { admin: true, added: [{ tab: 'x', label: 'X' }] }))
  for (const step of s.steps) {
    assert.ok(step.anchor && step.title && step.text, `${s.id}: ${step.title}`);
    assert.ok(step.text.length <= 170, `${s.id}: "${step.title}" is short`);
    assert.ok(!/[—–]/.test(step.text + step.title), `${s.id}: no em or en dashes`);
  }

// The phone text lists the same tabs, with Forge and Bots only for an admin.
assert.match(tourText(), /^A quick tour of Kairos:/);
for (const tab of ['Home', 'Chats', 'Notes', 'Library', 'Calendar', 'Email', 'Tasks', 'Tool Store', 'Cookbook', 'Settings']) assert.ok(tourText().includes(`- ${tab}:`), tab);
assert.ok(!tourText().includes('Forge') && tourText({ admin: true }).includes('- Forge:') && tourText({ admin: true }).includes('- Bots:'));
assert.ok(!/Agents:/.test(tourText({ admin: true })), 'the retired Agents tab is gone');

console.log('PASS: tour plan for people and admins, added tabs, short plain steps, phone text');
