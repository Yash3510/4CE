// Unit tests for the parts that must never be wrong: checksums, the vault's late-binding rules,
// and the egress gate. Run: npm test (bundles with esbuild, runs on node:test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { egressCheck } from '../lib/egress/gate';
import { fieldType, isAadhaar, isCard, scanText } from '../lib/pii/validators';
import { scrubText } from '../lib/tokens/scrub';
import { Vault } from '../lib/tokens/vault';

const A = 'https://claims.example.test';
const B = 'https://evil.example.test';

test('checksums decide', () => {
  assert.ok(isAadhaar('8493 3775 2953'));
  assert.ok(!isAadhaar('8493 3775 2954'));
  assert.ok(isCard('4003 8232 9425 0125').ok);
  assert.ok(!isCard('4003 8232 9425 0126').ok);
  const types = scanText('PAN BQKPI4821M, Aadhaar 8493 3775 2953, IFSC PRDA0004521, UPI ananya.iyer@okaxis, GSTIN 29AAKCP5821Q1ZL').map((m) => m.type);
  assert.deepEqual(types, ['PAN', 'AADHAAR', 'IFSC', 'UPI', 'GSTIN']);
  assert.equal(scanText('Order 123456789012 placed').length, 0); // 12 digits, bad Verhoeff: not an Aadhaar
});

test('names: greeting, gazetteer, never across lines', () => {
  assert.deepEqual(scanText('Hi Ananya, call Rohan Mehta').map((m) => m.value), ['Ananya', 'Rohan Mehta']);
  assert.deepEqual(scanText('Ananya Iyer\nAccount number').map((m) => m.value), ['Ananya Iyer']);
  assert.equal(scanText('Travel Desk and Design Review').length, 0);
});

test('field semantics: autocomplete beats input type', () => {
  assert.equal(fieldType({ inputType: 'password', autocomplete: 'cc-csc' }), 'CVV');
  assert.equal(fieldType({ inputType: 'text', label: 'Aadhaar number' }), 'AADHAAR');
  assert.equal(fieldType({ inputType: 'text', label: 'Bank name' }), null);
});

test('same value, same token; scrub replaces known values and name parts', () => {
  const v = new Vault();
  const t1 = v.tokenFor('NAME', 'Ananya Iyer', '*', 'profile');
  assert.equal(v.tokenFor('NAME', 'ananya  iyer', A), t1);
  assert.equal(scrubText('Welcome back, Ananya! PAN BQKPI4821M', v, A), 'Welcome back, ⟦NAME_1⟧! PAN ⟦PAN_1⟧');
});

test('late binding: screen values stay on their origin, secrets are never re-typed', () => {
  const v = new Vault();
  const email = v.tokenFor('EMAIL', 'a.b@mail.test', A);
  const pw = v.tokenFor('PASSWORD', 'hunter2!', A);
  const aad = v.tokenFor('AADHAAR', '8493 3775 2953', '*', 'profile');

  const ok = v.resolve(`⟦${email}⟧`, A);
  assert.equal(ok.text, 'a.b@mail.test');
  assert.equal(ok.denied.length, 0);

  const cross = v.resolve(`⟦${email}⟧`, B); // an injected page asking to carry it elsewhere
  assert.equal(cross.denied.length, 1);
  assert.equal(cross.text, `⟦${email}⟧`);

  assert.equal(v.resolve(`⟦${pw}⟧`, A).denied.length, 1);

  const prof = v.resolve(`⟦${aad}⟧`, B); // profile value on a new site: needs the user's consent
  assert.equal(prof.needsConsent.length, 1);
  v.approve(aad, B);
  assert.equal(v.resolve(`⟦${aad}⟧`, B).needsConsent.length, 0);
  assert.deepEqual(v.resolve('⟦AADHAAR_9⟧', A).unknown, ['AADHAAR_9']);
});

test('egress gate blocks raw values, validator hits and canaries; passes tokens', () => {
  const v = new Vault();
  v.tokenFor('NAME', 'Ananya Iyer', '*', 'profile');
  const clean = { goal: 'fill ⟦NAME_1⟧', text: 'Hello ⟦NAME_1⟧', frame: { b64: 'AAAA', sha256: 'ab'.repeat(32) } };
  assert.ok(egressCheck(clean, v, ['Rohan Mehta']).ok);
  assert.ok(!egressCheck({ text: 'Hello Ananya Iyer' }, v, []).ok);
  assert.ok(!egressCheck({ text: 'card 4003 8232 9425 0125' }, v, []).ok);
  assert.ok(!egressCheck({ elements: [{ label: 'rohan mehta' }] }, v, ['Rohan Mehta']).ok);
});
