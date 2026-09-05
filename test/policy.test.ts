import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  screenCreative, mayPublish, worstVerdict, findPhrase, normaliseAggressive,
  mergeReviewFeedback, decideRemediation, assertMayPublish,
  LineageHaltedError, ScreenInputError,
  MAX_REMEDIATION_ATTEMPTS, PERSONAL_ATTRIBUTE_WINDOW_TOKENS,
  type ScreenBrand, type CreativeDescriptor, type Finding, type ScreenReport,
} from '../src/policy/screen.ts';
import type { Brand } from '../src/domain/brand.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPROVED = 'Reduces the appearance of fine lines in 4 weeks';

function brand(over: Partial<ScreenBrand> = {}): ScreenBrand {
  return {
    id: 'lumen',
    claims: {
      substantiated: [APPROVED],
      neverSay: [],
      neverShow: [],
      likenessRightsConfirmed: false,
    },
    specialAdCategories: ['NONE'],
    countries: ['GB'],
    ...over,
  };
}

function creative(over: Partial<CreativeDescriptor> = {}): CreativeDescriptor {
  return {
    lineageId: 'lin-1',
    aiGenerated: true,
    copy: { primaryText: 'Meet the daily moisturiser from Lumen. Shop now.' },
    ...over,
  };
}

function copy(primaryText: string, rest: Partial<CreativeDescriptor> = {}): CreativeDescriptor {
  return creative({ copy: { primaryText }, ...rest });
}

const ids = (r: ScreenReport): string[] => r.findings.map((f) => f.ruleId);
const find = (r: ScreenReport, id: string): Finding | undefined => r.findings.find((f) => f.ruleId === id);

// A real Brand must be usable directly — if these two drift apart, this stops compiling.
const _assignable: (b: Brand) => ScreenBrand = (b) => b;
void _assignable;

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test('compliant copy inside the approved claim set passes with no findings', () => {
  const r = screenCreative(brand(), copy(`Meet the daily moisturiser from Lumen. ${APPROVED}. Shop now.`));
  assert.deepEqual(r.findings, [], `unexpected findings: ${ids(r).join(', ')}`);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.complete, true);
  assert.equal(mayPublish(r), true);
});

test('screening is pure — the same inputs give a byte-identical report', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: ['guaranteed'], neverShow: [], likenessRightsConfirmed: false } });
  const c = copy('Results guaranteed in 7 days.');
  assert.deepEqual(screenCreative(b, c), screenCreative(b, c));
});

test('worstVerdict is the ranking the report relies on', () => {
  assert.equal(worstVerdict([]), 'PASS');
  assert.equal(worstVerdict(['PASS', 'WARN']), 'WARN');
  assert.equal(worstVerdict(['WARN', 'BLOCK', 'PASS']), 'BLOCK');
});

// ---------------------------------------------------------------------------
// Fail-closed inputs
// ---------------------------------------------------------------------------

test('empty copy is a BLOCK, never a PASS', () => {
  const r = screenCreative(brand(), copy('   '));
  assert.equal(r.verdict, 'BLOCK');
  assert.deepEqual(ids(r), ['input.empty-copy']);
  assert.equal(mayPublish(r), false);
});

test('a missing lineageId throws rather than screening an unenforceable creative', () => {
  assert.throws(
    () => screenCreative(brand(), creative({ lineageId: '' })),
    ScreenInputError,
    'without a lineage the dri_* halt and the 2-attempt cap cannot be enforced',
  );
});

test('a short-circuited report is never mistaken for a clean one', () => {
  const r = screenCreative(brand(), copy('Lose 30 lbs in 30 days.'), { stopAtFirstBlock: true });
  assert.equal(r.complete, false);
  assert.equal(mayPublish(r), false, 'incomplete reports must not authorise a publish');
  assert.ok(r.stagesRun.length < 6, 'it should have stopped before the last stage');
});

// ---------------------------------------------------------------------------
// neverSay / neverShow and evasion
// ---------------------------------------------------------------------------

const guarded = (): ScreenBrand =>
  brand({ claims: { substantiated: [APPROVED], neverSay: ['guaranteed'], neverShow: ['competitor logo'], likenessRightsConfirmed: false } });

test('a literal neverSay phrase blocks and is not flagged as an evasion', () => {
  const r = screenCreative(guarded(), copy('Guaranteed, or your money back.'));
  const f = find(r, 'brand.neverSay');
  assert.ok(f, 'the phrase is present');
  assert.equal(f.severity, 'BLOCK');
  assert.equal(f.evasion, undefined);
  assert.equal(f.span?.text, 'Guaranteed');
  assert.equal(f.span?.field, 'primaryText');
});

for (const [label, text, expected] of [
  ['spacing', 'Results g u a r a n t e e d today.', 'g u a r a n t e e d'],
  ['punctuation', 'Results g-u-a-r.a.n-t-e-e-d today.', 'g-u-a-r.a.n-t-e-e-d'],
  ['leetspeak', 'Results gu4r4nteed today.', 'gu4r4nteed'],
  ['letter doubling', 'Results guaaaranteed today.', 'guaaaranteed'],
  ['cyrillic homoglyph', 'Results guаrаnteed today.', 'guаrаnteed'],
  ['zero-width', 'Results guar​anteed today.', 'guar​anteed'],
] as const) {
  test(`neverSay survives ${label} evasion and reports the literal span`, () => {
    const r = screenCreative(guarded(), copy(text));
    const f = find(r, 'brand.neverSay');
    assert.ok(f, `"${text}" must still match "guaranteed"`);
    assert.equal(f.evasion, true, 'the finding must say it was an evasion, not a literal hit');
    assert.equal(f.span?.text, expected, 'the span must point at the original bytes, not the normalised form');
  });
}

test('neverSay does not fire on an unrelated phrase', () => {
  const r = screenCreative(guarded(), copy('A gentle daily moisturiser.'));
  assert.equal(find(r, 'brand.neverSay'), undefined);
});

test('neverShow screens the shot list, not the ad copy', () => {
  const inCopy = screenCreative(guarded(), copy('Better than any competitor logo out there.'));
  assert.equal(find(inCopy, 'brand.neverShow'), undefined, 'neverShow governs depiction, not mention');

  const inShots = screenCreative(
    guarded(),
    creative({ visualDescription: ['Close-up of a competitor logo on the shelf'] }),
  );
  const f = find(inShots, 'brand.neverShow');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
  assert.equal(f.span?.field, 'visualDescription');
  assert.equal(f.span?.index, 0);
});

test('findPhrase reports offsets into the original string', () => {
  const hit = findPhrase('xx CLINICALLY-PROVEN yy', 'clinically proven');
  assert.ok(hit);
  assert.equal(hit.start, 3);
  assert.equal(hit.text, 'CLINICALLY-PROVEN');
  assert.equal(normaliseAggressive('Guaranteed!!').text, 'guaranted', 'runs collapse symmetrically on both sides');
});

// ---------------------------------------------------------------------------
// Claim-set enforcement
// ---------------------------------------------------------------------------

test('an assertion that restates an approved claim is allowed', () => {
  const r = screenCreative(brand(), copy('Reduces fine lines in 4 weeks.'));
  assert.equal(find(r, 'claim-set.unsubstantiated-assertion'), undefined, ids(r).join(', '));
});

test('changing the number in an approved claim is unsubstantiated', () => {
  const r = screenCreative(brand(), copy('Reduces the appearance of fine lines in 2 weeks.'));
  const f = find(r, 'claim-set.unsubstantiated-assertion');
  assert.ok(f, 'a different number is a different claim');
  assert.equal(f.severity, 'BLOCK');
  assert.match(f.message, /Closest approved claim/, 'the rewriter needs the nearest approved claim');
  assert.match(f.message, new RegExp(APPROVED));
});

test('adding an efficacy marker the brand never substantiated is unsubstantiated', () => {
  const r = screenCreative(brand(), copy('Clinically proven to reduce fine lines in 4 weeks.'));
  assert.ok(find(r, 'claim-set.unsubstantiated-assertion'), 'the marker must appear in the approved claim too');
  assert.ok(find(r, 'health-claims.efficacy-language'), 'and the rule pack warns about it independently');
});

test('non-assertive copy asserts nothing and needs no substantiation', () => {
  for (const line of ['Shop the new collection today.', 'Ready for a change?', 'Free delivery on all orders.']) {
    const r = screenCreative(brand(), copy(line));
    assert.equal(find(r, 'claim-set.unsubstantiated-assertion'), undefined, `"${line}" should not read as a claim`);
  }
});

test('a brand with no substantiated claims cannot assert anything at all', () => {
  const b = brand({ claims: { substantiated: [], neverSay: [], neverShow: [], likenessRightsConfirmed: false } });
  const r = screenCreative(b, copy('Reduces fine lines in 4 weeks.'));
  const f = find(r, 'claim-set.no-approved-claims');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
});

test('the offending span points at the sentence a rewriter has to replace', () => {
  const text = 'A gentle daily moisturiser. Erases wrinkles in 3 days.';
  const r = screenCreative(brand(), copy(text));
  const f = find(r, 'claim-set.unsubstantiated-assertion');
  assert.ok(f);
  assert.equal(text.slice(f.span?.start ?? 0, f.span?.end ?? 0), 'Erases wrinkles in 3 days');
});

// ---------------------------------------------------------------------------
// Rule pack
// ---------------------------------------------------------------------------

test('quantified outcome plus a short timeframe blocks', () => {
  const r = screenCreative(brand(), copy('Lose 30 lbs in 30 days.'));
  const f = find(r, 'unrealistic-outcomes.timeframe');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
  assert.match(f.policy.url, /transparency\.meta\.com|facebook\.com\/business/);
});

test('a guaranteed RESULT blocks but a money-back guarantee does not', () => {
  assert.ok(find(screenCreative(brand(), copy('Guaranteed results in one session.')), 'unrealistic-outcomes.guaranteed-result'));
  assert.equal(
    find(screenCreative(brand(), copy('Try it with our money-back guarantee.')), 'unrealistic-outcomes.guaranteed-result'),
    undefined,
    'a guarantee about the purchase is a normal DR offer term, not an outcome promise',
  );
});

test('curing an incurable disease blocks, in copy and in shot direction', () => {
  assert.ok(find(screenCreative(brand(), copy('This supplement cures diabetes.')), 'unrealistic-outcomes.cure-incurable'));
  const shots = screenCreative(brand(), creative({ visualDescription: ['Caption reads: reverses arthritis in weeks'] }));
  assert.ok(find(shots, 'unrealistic-outcomes.cure-incurable'), 'burned-in text is screened identically');
});

test('an income rate blocks but an ordinary price does not', () => {
  assert.ok(find(screenCreative(brand(), copy('Earn $10,000 a month from your phone.')), 'unrealistic-outcomes.income-promise'));
  assert.equal(
    find(screenCreative(brand(), copy('Make your $50 gift card go further.')), 'unrealistic-outcomes.income-promise'),
    undefined,
    'a bare figure is not an earnings promise',
  );
});

test('before/after is a WARN with the 18+ remedy, not a block', () => {
  const r = screenCreative(brand(), copy('See the before and after.'));
  const f = find(r, 'personal-health.before-after');
  assert.ok(f);
  assert.equal(f.severity, 'WARN', 'before/after is not categorically banned — most guides get this wrong');
  assert.match(f.remedy, /age_min = 18/);
});

test('negative self-perception blocks', () => {
  const f = find(screenCreative(brand(), copy('Are you overweight? We can help.')), 'personal-health.negative-self-perception');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
});

test('absolute superlatives and engagement bait warn', () => {
  const sup = find(screenCreative(brand(), copy('The #1 moisturiser in Britain.')), 'superlatives.absolute');
  assert.equal(sup?.severity, 'WARN');
  const bait = find(screenCreative(brand(), copy('Tag a friend who needs this.')), 'engagement-bait');
  assert.equal(bait?.severity, 'WARN');
  assert.match(bait?.message ?? '', /RANKING guideline/, 'engagement bait costs delivery, it is not a rejection');
});

test('prohibited financial products block and crypto warns', () => {
  assert.equal(find(screenCreative(brand(), copy('Fast payday loans, no paperwork.')), 'financial.prohibited-product')?.severity, 'BLOCK');
  assert.equal(find(screenCreative(brand(), copy('Start crypto trading today.')), 'financial.cryptocurrency')?.severity, 'WARN');
});

test('a realness claim blocks only when the creative is AI-generated', () => {
  const line = 'Real customers, real results.';
  assert.ok(find(screenCreative(brand(), copy(line)), 'ai-content.realness-claim'), 'AI creative cannot claim the footage is real');
  assert.equal(
    find(screenCreative(brand(), copy(line, { aiGenerated: false })), 'ai-content.realness-claim'),
    undefined,
  );
});

test('flashing shot direction warns', () => {
  assert.ok(find(screenCreative(brand(), creative({ visualDescription: ['Rapid flashing lights over the logo'] })), 'video.disruptive-tactics'));
});

// ---------------------------------------------------------------------------
// Personal attributes
// ---------------------------------------------------------------------------

test('second person next to a protected attribute blocks', () => {
  const r = screenCreative(brand(), copy('Are you struggling with diabetes?'));
  const f = find(r, 'personal-attributes.second-person-proximity');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
  assert.match(f.message, /physical or mental health/);
});

test('the same attribute in the third person is allowed', () => {
  const r = screenCreative(brand(), copy('New options for people managing diabetes.'));
  assert.equal(find(r, 'personal-attributes.second-person-proximity'), undefined);
});

test('second person alone is allowed — Meta says so explicitly', () => {
  const r = screenCreative(brand(), copy('You deserve a moisturiser that works for your skin.'));
  assert.equal(
    find(r, 'personal-attributes.second-person-proximity'),
    undefined,
    'keying on the pronoun alone would block nearly all direct-response copy',
  );
});

test('a passing age reference with no second person is allowed', () => {
  assert.equal(
    find(screenCreative(brand(), copy('Designed for the 50+ crowd.')), 'personal-attributes.second-person-proximity'),
    undefined,
  );
});

test('the window crosses sentence boundaries, because Meta\'s own example does', () => {
  const r = screenCreative(brand(), copy('Bad credit? We can help you.'));
  assert.ok(
    find(r, 'personal-attributes.second-person-proximity'),
    'the attribute and the pronoun sit in different sentences here',
  );
});

test('a distant pronoun outside the window does not fire', () => {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed';
  const r = screenCreative(brand(), copy(`Support for diabetes ${filler} and it is right for you.`));
  assert.equal(find(r, 'personal-attributes.second-person-proximity'), undefined);
  assert.equal(PERSONAL_ATTRIBUTE_WINDOW_TOKENS, 10);
});

// ---------------------------------------------------------------------------
// Special ad categories
// ---------------------------------------------------------------------------

test('employment copy under specialAdCategories NONE is a blocking mismatch', () => {
  const r = screenCreative(brand(), copy('Now hiring delivery drivers. Join our team.'));
  const f = find(r, 'special-ad-category.mismatch.employment');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
  assert.match(f.remedy, /special_ad_category_country/);
});

test('declaring the category clears the mismatch', () => {
  const r = screenCreative(brand({ specialAdCategories: ['EMPLOYMENT'] }), copy('Now hiring delivery drivers.'));
  assert.equal(find(r, 'special-ad-category.mismatch.employment'), undefined);
});

test('housing copy under NONE blocks', () => {
  assert.ok(find(screenCreative(brand(), copy('Apartments for rent in Austin.')), 'special-ad-category.mismatch.housing'));
});

test('credit signals are satisfied by FINANCIAL_PRODUCTS_SERVICES, the successor to CREDIT', () => {
  const line = 'Compare personal loans in one place.';
  assert.ok(find(screenCreative(brand(), copy(line)), 'special-ad-category.mismatch.credit'));
  assert.equal(
    find(screenCreative(brand({ specialAdCategories: ['FINANCIAL_PRODUCTS_SERVICES'] }), copy(line)), 'special-ad-category.mismatch.credit'),
    undefined,
  );
});

test('the deprecated CREDIT value warns, and the certification precondition is surfaced', () => {
  const r = screenCreative(brand({ specialAdCategories: ['CREDIT'] }), copy('A gentle daily moisturiser.'));
  assert.equal(find(r, 'special-ad-category.credit-deprecated')?.severity, 'WARN');
  const cert = find(r, 'special-ad-category.certification-precondition');
  assert.ok(cert);
  assert.match(cert.message, /2859024/, 'error 2859024 cannot be cleared by any API call');
});

test('SIEP is blocked whatever the brand declares', () => {
  assert.ok(find(screenCreative(brand(), copy('Register to vote before Tuesday.')), 'special-ad-category.siep'));
  const declared = screenCreative(brand({ specialAdCategories: ['ISSUES_ELECTIONS_POLITICS'] }), copy('A gentle daily moisturiser.'));
  assert.equal(find(declared, 'special-ad-category.siep-declared')?.severity, 'BLOCK');
});

// ---------------------------------------------------------------------------
// Likeness
// ---------------------------------------------------------------------------

const presenter = (over: Partial<NonNullable<CreativeDescriptor['presenter']>> = {}): CreativeDescriptor =>
  creative({ presenter: { kind: 'synthetic_human', framing: 'presenter', voice: 'synthetic_generic', ...over } });

test('an unconfirmed likeness blocks any human presenter', () => {
  const f = find(screenCreative(brand(), presenter()), 'likeness.rights-unconfirmed');
  assert.ok(f);
  assert.equal(f.severity, 'BLOCK');
  assert.match(f.remedy, /likenessRightsConfirmed = true/);
});

test('a cloned voice needs the same confirmation as a face', () => {
  const c = creative({ presenter: { kind: 'none', framing: 'narrator', voice: 'cloned_licensed' } });
  assert.ok(find(screenCreative(brand(), c), 'likeness.rights-unconfirmed'));
});

test('confirming the rights clears the block for a plain presenter', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true } });
  const r = screenCreative(b, presenter());
  assert.equal(find(r, 'likeness.rights-unconfirmed'), undefined);
  assert.equal(r.verdict, 'PASS', ids(r).join(', '));
});

test('no presenter means no likeness findings at all', () => {
  const r = screenCreative(brand(), creative({ presenter: { kind: 'none', framing: 'narrator', voice: 'none' } }));
  assert.deepEqual(ids(r).filter((i) => i.startsWith('likeness.')), []);
});

test('an unlicensed voice clone blocks even when rights are confirmed', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true } });
  assert.ok(find(screenCreative(b, presenter({ voice: 'cloned_unlicensed' })), 'likeness.cloned-voice-unlicensed'));
});

test('resembling a named real person always blocks', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true } });
  const f = find(screenCreative(b, presenter({ resemblesRealPerson: 'a well-known TV doctor' })), 'likeness.resembles-real-person');
  assert.ok(f);
  assert.match(f.remedy, /Discard this render/);
});

test('a synthetic presenter framed as a customer testimonial blocks on FTC grounds', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true } });
  const f = find(screenCreative(b, presenter({ framing: 'customer_testimonial' })), 'likeness.synthetic-testimonial');
  assert.ok(f);
  assert.equal(f.policy.id, 'ftc/16-cfr-465');
});

test('first-person result language reaches the same violation through the script', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true } });
  const c = creative({
    presenter: { kind: 'synthetic_human', framing: 'presenter', voice: 'synthetic_generic' },
    copy: { primaryText: 'Honestly, it changed my life.' },
  });
  assert.ok(find(screenCreative(b, c), 'likeness.first-person-result'));
});

test('a synthetic clinician warns with the litigated fact pattern named', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true } });
  const f = find(screenCreative(b, presenter({ description: 'Woman in a white coat with a stethoscope' })), 'likeness.clinical-authority-figure');
  assert.equal(f?.severity, 'WARN');
});

test('an AI human presenter delivered into the EU needs an in-creative disclosure', () => {
  const b = brand({
    claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true },
    countries: ['DE', 'US'],
  });
  const f = find(screenCreative(b, presenter()), 'likeness.eu-disclosure-required');
  assert.ok(f);
  assert.match(f.remedy, /three-dot menu/, 'Meta\'s own AI label does not satisfy Art. 50(5)');
  assert.equal(
    find(screenCreative(brand({ ...b, countries: ['US'] }), presenter()), 'likeness.eu-disclosure-required'),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Remediation policy
// ---------------------------------------------------------------------------

const fresh = { lineageId: 'lin-1', attempts: 0, halted: false } as const;

test('placement_specific reasons are merged in, so an empty global is not "no reason given"', () => {
  const merged = mergeReviewFeedback({
    global: {},
    placementSpecific: { instagram: { LOW_QUALITY: 'How to fix: rewrite the headline.' } },
  });
  assert.deepEqual(merged, [{ surface: 'instagram', code: 'LOW_QUALITY', message: 'How to fix: rewrite the headline.' }]);
});

test('an ordinary disapproval retries as a NEW ad in the same ad set', () => {
  const d = decideRemediation({
    lineage: fresh,
    feedback: { global: { PERSONAL_ATTRIBUTES: 'How to fix: remove the reference.' } },
  });
  assert.equal(d.disposition, 'RETRY');
  assert.equal(d.action, 'NEW_AD_IN_SAME_ADSET');
  assert.equal(d.pageHuman, false);
  assert.deepEqual(d.verbatimReasons, ['How to fix: remove the reference.']);
  assert.equal(d.attemptsRemaining, MAX_REMEDIATION_ATTEMPTS);
  assert.match(d.reason, /resets learning/);
});

test('a dri_ surface halts the lineage on the very first attempt', () => {
  const d = decideRemediation({
    lineage: fresh,
    feedback: { placementSpecific: { dri_copyright: { X: 'Rights holder report.' } } },
  });
  assert.equal(d.disposition, 'HALT');
  assert.equal(d.action, 'NONE');
  assert.equal(d.pauseScope, 'lineage');
  assert.equal(d.pageHuman, true);
  assert.equal(d.attemptsRemaining, 0);
});

test('an unseen dri_* surface halts too — the surface list is discovered by observation', () => {
  const d = decideRemediation({ lineage: fresh, feedback: { placementSpecific: { dri_trademark: { X: 'y' } } } });
  assert.equal(d.disposition, 'HALT');
});

test('a halted lineage stays halted and refuses to publish', () => {
  const halted = { lineageId: 'lin-1', attempts: 0, halted: true };
  assert.equal(decideRemediation({ lineage: halted, feedback: {} }).disposition, 'HALT');
  assert.throws(() => assertMayPublish(halted), LineageHaltedError);
  assert.doesNotThrow(() => assertMayPublish(fresh));
});

test('a political reclassification quarantines the campaign and pages', () => {
  const d = decideRemediation({
    lineage: fresh,
    feedback: { global: { X: 'y' } },
    effectiveAuthorizationCategory: 'POLITICAL',
  });
  assert.equal(d.disposition, 'QUARANTINE');
  assert.equal(d.pauseScope, 'campaign');
  assert.equal(d.pageHuman, true);
});

test('the attempt budget is two per lineage, then quarantine', () => {
  const fb = { global: { X: 'How to fix: something.' } };
  assert.equal(decideRemediation({ lineage: { ...fresh, attempts: 1 }, feedback: fb }).disposition, 'RETRY');
  const spent = decideRemediation({ lineage: { ...fresh, attempts: MAX_REMEDIATION_ATTEMPTS }, feedback: fb });
  assert.equal(spent.disposition, 'QUARANTINE');
  assert.equal(spent.pageHuman, true);
  assert.equal(spent.attemptsRemaining, 0);
});

test('an IP halt outranks the attempt budget in both directions', () => {
  const d = decideRemediation({
    lineage: { ...fresh, attempts: 5 },
    feedback: { placementSpecific: { dri_counterfeit: { X: 'y' } } },
  });
  assert.equal(d.disposition, 'HALT', 'a copyright complaint is never a quarantine to be reviewed and retried');
});

test('a disapproval with no readable reason quarantines rather than regenerating blind', () => {
  const d = decideRemediation({ lineage: fresh, feedback: { global: {}, placementSpecific: {} } });
  assert.equal(d.disposition, 'QUARANTINE');
  assert.equal(d.pageHuman, true);
});

// ---------------------------------------------------------------------------
// Normaliser regressions — both of these were real defects
// ---------------------------------------------------------------------------

test('leetspeak folding is gated to intra-word position', () => {
  // Un-gated folding turned "!" into "i" and "$50" into "so", which broke real matches.
  assert.equal(normaliseAggressive('Guaranteed!!').text, 'guaranted');
  assert.equal(normaliseAggressive('$50 off').text, '50of');
  assert.equal(normaliseAggressive('gu4ranteed').text, 'guaranted', 'intra-word substitution still folds');
});

test('a multi-word neverSay phrase survives punctuation between the words', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: ['risk free'], neverShow: [], likenessRightsConfirmed: false } });
  for (const line of ['Totally risk-free.', 'Totally risk! free.', 'Totally RISK   FREE.']) {
    assert.ok(find(screenCreative(b, copy(line)), 'brand.neverSay'), `"${line}" must match "risk free"`);
  }
});

test('burned-in on-screen text is screened and reports its own field and index', () => {
  const b = brand({ claims: { substantiated: [APPROVED], neverSay: ['clinically proven'], neverShow: [], likenessRightsConfirmed: false } });
  const c = creative({ copy: { primaryText: 'A gentle daily moisturiser.', onScreenText: ['CLINICALLY PROVEN'] } });
  const f = find(screenCreative(b, c), 'brand.neverSay');
  assert.ok(f, 'most policy-violating text in a video ad is burned into the frame');
  assert.equal(f.span?.field, 'onScreenText');
  assert.equal(f.span?.index, 0);
});

test('a warnings-only creative reports WARN and is still publishable', () => {
  const r = screenCreative(brand(), copy('Tag a friend who needs this.'));
  assert.equal(r.verdict, 'WARN', ids(r).join(', '));
  assert.equal(mayPublish(r), true, 'a WARN is interpretable, not a refusal');
});

test('every finding carries a policy reference and a remedy a rewriter can act on', () => {
  const r = screenCreative(
    guarded(),
    copy('Are you overweight? Guaranteed results in 7 days. Now hiring. Tag a friend.'),
  );
  assert.ok(r.findings.length >= 4);
  for (const f of r.findings) {
    assert.ok(f.policy.id.length > 0 && f.policy.url.length > 0, `${f.ruleId} must cite a policy`);
    assert.ok(f.remedy.trim().length > 0, `${f.ruleId} must say what to change`);
    assert.ok(f.message.trim().length > 0, `${f.ruleId} must name the actual cause`);
  }
});

// ---------------------------------------------------------------------------
// Review regressions — each of these was a live defect
// ---------------------------------------------------------------------------

test('negative self-perception needs a body/appearance object, not just "your"', () => {
  // The shame arm used to fire on `<shame verb> ... your <anything>`, which BLOCKed
  // ordinary DR copy with no Personal Health dimension at all.
  for (const line of [
    'Sick of your slow commute? Try the new app.',
    'Embarrassed by your outdated website? We rebuild it.',
    'Tired of your old mattress?',
  ]) {
    assert.equal(
      find(screenCreative(brand(), copy(line)), 'personal-health.negative-self-perception'),
      undefined,
      `"${line}" shames nothing about the reader's body — a BLOCK here stops publishing for no reason`,
    );
  }
  for (const line of [
    'Are you embarrassed by your belly fat?',
    'Ashamed of your wrinkles?',
    'Sick of your double chin?',
    'Sick of your thinning hair?',
    'Are you overweight? We can help.',
  ]) {
    assert.ok(
      find(screenCreative(brand(), copy(line)), 'personal-health.negative-self-perception'),
      `"${line}" is the violation the rule exists for`,
    );
  }
});

test('the age attribute sees "50+" and stops seeing "over 40 colours"', () => {
  // `\d0\s?\+` followed by a group-level \b never matched: "+" is not a word character,
  // so the boundary after it could not fire. The whole plus-form was dead.
  assert.ok(
    find(screenCreative(brand(), copy('Designed for the 50+ crowd, and it is right for you.')), 'personal-attributes.second-person-proximity'),
    '"50+" next to "you" is exactly the conjunction the rule screens for',
  );
  // ...while "over N <plural noun>" is counting, not an age reference.
  for (const line of [
    'Over 40 colours to choose from — pick yours today.',
    'Over 50 recipes for you to try.',
    'Get $50 + free shipping on your order.',
    'Over 40 percent of your team already use it.',
  ]) {
    assert.equal(
      find(screenCreative(brand(), copy(line)), 'personal-attributes.second-person-proximity'),
      undefined,
      `"${line}" contains no age reference`,
    );
  }
  for (const line of ['Are you over 60? You qualify.', 'Rates for retirees like you.', 'Cover for the over-50s — get your quote.']) {
    assert.ok(find(screenCreative(brand(), copy(line)), 'personal-attributes.second-person-proximity'), line);
  }
});

test('a cloned voice into the EU needs the same in-creative disclosure as a face', () => {
  const b = brand({
    claims: { substantiated: [APPROVED], neverSay: [], neverShow: [], likenessRightsConfirmed: true },
    countries: ['DE'],
  });
  const cloned = creative({ presenter: { kind: 'none', framing: 'narrator', voice: 'cloned_licensed' } });
  const f = find(screenCreative(b, cloned), 'likeness.eu-disclosure-required');
  assert.ok(f, 'Art. 50(4) covers synthetic audio; a voice clone is a likeness with no face on screen');
  // A genuine recording is not artificially generated, so it carries no marking obligation.
  const recorded = creative({ presenter: { kind: 'none', framing: 'narrator', voice: 'real_recorded' } });
  assert.equal(find(screenCreative(b, recorded), 'likeness.eu-disclosure-required'), undefined);
});

test('a decimal does not split one claim into two nonsense fragments', () => {
  const text = 'Cuts drying time by 1.5x.';
  const r = screenCreative(brand(), copy(text));
  const f = find(r, 'claim-set.unsubstantiated-assertion');
  assert.ok(f, 'still unsubstantiated');
  assert.equal(
    text.slice(f.span?.start ?? 0, f.span?.end ?? 0),
    'Cuts drying time by 1.5x',
    'the span must be the whole claim, not the fragment after the decimal point',
  );
  // The sentence-final stop after a digit must still end the sentence.
  const two = screenCreative(brand(), copy('Yours for $29.99. Erases wrinkles in 3 days.'));
  const g = find(two, 'claim-set.unsubstantiated-assertion');
  assert.ok(g);
  assert.equal(g.span?.text, 'Erases wrinkles in 3 days');
});

test('a report in which no stage ran is not marked complete', () => {
  const r = screenCreative(brand(), copy('   '));
  assert.deepEqual(r.stagesRun, []);
  assert.equal(r.complete, false, 'nothing was screened, so nothing is known about the rest of the creative');
  assert.equal(mayPublish(r), false);
});

test('offer language is not an efficacy claim, but a magnitude claim still is', () => {
  const offers = ['Save 20% this week.', '20% off everything.', 'Yours for $29.99.', 'Try it for 30 days.'];
  for (const line of offers) {
    assert.equal(
      find(screenCreative(brand(), copy(line)), 'claim-set.unsubstantiated-assertion'),
      undefined,
      `"${line}" is an offer term, not a claim the brand has to substantiate`,
    );
  }
  for (const line of ['Cuts drying time by 40%.', 'Lose 12 lbs.', 'Works in 3 days.']) {
    assert.ok(
      find(screenCreative(brand(), copy(line)), 'claim-set.unsubstantiated-assertion'),
      `"${line}" asserts a magnitude or a promised timeframe and must be substantiated`,
    );
  }
});
