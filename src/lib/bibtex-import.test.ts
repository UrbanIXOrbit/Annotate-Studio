import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBibtexNames, bibtexToCitation, keywordsOf, matchEntries, type MatchFile } from './bibtex-import.ts';
import { parseBibtex } from './bibtex.ts';

test('splitBibtexNames splits on " and " but not inside braces', () => {
  assert.deepEqual(splitBibtexNames('Kandel, Eric R. and Squire, Larry R.'), ['Kandel, Eric R.', 'Squire, Larry R.']);
  assert.deepEqual(splitBibtexNames('Barnes {and} Noble and Other, A.'), ['Barnes {and} Noble', 'Other, A.']);
  assert.deepEqual(splitBibtexNames('One Author'), ['One Author']);
  assert.deepEqual(splitBibtexNames('  '), []);
});

test('bibtexToCitation maps fields onto the BookCitation shape', () => {
  const parsed = parseBibtex(`@article{kandel2012,
    author = {Kandel, Eric R. and Squire, Larry R.},
    title = {Principles of {Neural Science}},
    journal = {Neuron},
    year = 2012,
    volume = 74,
    number = 3,
    pages = {12--30},
    doi = {10.1234/neuron.2012},
    language = {english},
    note = {scanned copy}
  }`);
  const citation = bibtexToCitation(parsed.entries[0]);
  assert.equal(citation.title, 'Principles of {Neural Science}');
  assert.deepEqual(citation.authors, ['Kandel, Eric R.', 'Squire, Larry R.']);
  assert.equal(citation.type, 'article');
  assert.equal(citation.container, 'Neuron');
  assert.equal(citation.volume, '74');
  assert.equal(citation.issue, '3');
  assert.equal(citation.pages, '12–30');
  assert.equal(citation.doi, '10.1234/neuron.2012');
  assert.equal(citation.language, 'english');
  assert.equal(citation.note, 'scanned copy');
  assert.equal(citation.source, 'manual');
  assert.equal(citation.confidence, 'medium');
  assert.equal(citation.editors, undefined);
});

test('bibtexToCitation maps entry types and editors', () => {
  const parsed = parseBibtex(`@incollection{friston,
    author = {Friston, Karl},
    editor = {Helmholtz, Hermann von and Mach, Ernst},
    booktitle = {Attention and Brain},
    year = {2010}
  }`);
  const citation = bibtexToCitation(parsed.entries[0]);
  assert.equal(citation.type, 'chapter');
  assert.equal(citation.container, 'Attention and Brain');
  assert.deepEqual(citation.editors, ['Helmholtz, Hermann von', 'Mach, Ernst']);

  const types: Array<[string, string]> = [
    ['@book{a, title={x}}', 'book'],
    ['@inproceedings{a, title={x}}', 'conference'],
    ['@phdthesis{a, title={x}}', 'thesis'],
    ['@unpublished{a, title={x}}', 'preprint'],
    ['@techreport{a, title={x}}', 'other'],
    ['@weirdtype{a, title={x}}', 'other'],
  ];
  for (const [bibtex, expected] of types) {
    assert.equal(bibtexToCitation(parseBibtex(bibtex).entries[0]).type, expected, bibtex);
  }
});

test('keywordsOf splits Zotero keywords into proposed tags', () => {
  const parsed = parseBibtex('@article{a, title={x}, keywords = {memory, sleep; consolidation}}');
  assert.deepEqual(keywordsOf(parsed.entries[0]), ['memory', 'sleep', 'consolidation']);
  assert.deepEqual(keywordsOf(parseBibtex('@article{b, title={x}}').entries[0]), []);
});

const FILES: MatchFile[] = [
  { id: 'f1', name: 'Kandel - Principles of Neural Science (2012).pdf' },
  { id: 'f2', name: 'kahneman_thinking_fast_slow_2011.pdf' },
  { id: 'f3', name: 'friston_free_energy_2010.pdf', doi: '10.1000/friston' },
  { id: 'f4', name: '10.1515_9783111611358-005.pdf' },
];

test('matchEntries auto-matches by DOI (citation or filename)', () => {
  const entry = parseBibtex('@article{a, title={Totally different title}, doi={10.1000/friston}}').entries[0];
  const [suggestion] = matchEntries([entry], FILES);
  assert.equal(suggestion.confidence, 'auto');
  assert.equal(suggestion.candidates[0].fileId, 'f3');
  assert.equal(suggestion.candidates[0].reason, 'doi');

  const entry2 = parseBibtex('@article{b, title={Another thing}, doi={10.1515/9783111611358-005}}').entries[0];
  const [suggestion2] = matchEntries([entry2], FILES);
  assert.equal(suggestion2.confidence, 'auto');
  assert.equal(suggestion2.candidates[0].fileId, 'f4');
});

test('matchEntries auto-matches close titles with the same year', () => {
  const entry = parseBibtex('@book{k, author={Kahneman, Daniel}, title={Thinking, Fast and Slow}, year={2011}}').entries[0];
  const [suggestion] = matchEntries([entry], FILES);
  assert.equal(suggestion.confidence, 'auto');
  assert.equal(suggestion.candidates[0].fileId, 'f2');
});

test('matchEntries demotes ambiguous or year-mismatched pairs to suggested', () => {
  // Same title, wrong year in the filename → downgraded.
  const entry = parseBibtex('@book{k, author={Kahneman, Daniel}, title={Thinking, Fast and Slow}, year={2019}}').entries[0];
  const [suggestion] = matchEntries([entry], FILES);
  assert.notEqual(suggestion.confidence, 'auto');

  // Two files that both look right → nobody wins automatically.
  const twins: MatchFile[] = [
    { id: 'a', name: 'Principles of Neural Science 2012.pdf' },
    { id: 'b', name: 'Principles of Neural Science 2012 (copy).pdf' },
  ];
  const [ambiguous] = matchEntries([parseBibtex('@book{t, title={Principles of Neural Science}, year={2012}}').entries[0]], twins);
  assert.equal(ambiguous.confidence, 'suggested');
});

test('matchEntries reports none when nothing resembles the entry', () => {
  const entry = parseBibtex('@article{z, title={Quantum chromodynamics lattice methods}, year={1988}}').entries[0];
  const [suggestion] = matchEntries([entry], FILES);
  assert.equal(suggestion.confidence, 'none');
  assert.deepEqual(suggestion.candidates, []);
});
